"""
tracker.py — Multi-object tracker with Re-ID for visitor session management.

Uses a Kalman-filter-based IoU tracker (ByteTrack-style) with appearance
embedding distance for cross-camera Re-ID and re-entry detection.

Design decisions documented in CHOICES.md.
"""

import numpy as np
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional
import uuid
import time


# ── Track state ───────────────────────────────────────────────────────────────

class TrackState:
    TENTATIVE = 'tentative'   # first seen, not yet confirmed
    CONFIRMED = 'confirmed'   # seen in N consecutive frames
    LOST      = 'lost'        # not seen recently, kept for Re-ID
    REMOVED   = 'removed'     # expired, archived


@dataclass
class KalmanBox:
    """Simple constant-velocity Kalman filter for bounding box tracking."""
    mean: np.ndarray      # [cx, cy, w, h, vx, vy, vw, vh]
    covariance: np.ndarray

    # Kalman matrices
    _F = np.eye(8)   # state transition
    _H = np.eye(4, 8)  # measurement
    _std_weight_position = 1.0 / 20
    _std_weight_velocity = 1.0 / 160

    @classmethod
    def initiate(cls, measurement: np.ndarray) -> 'KalmanBox':
        cx, cy, w, h = measurement
        mean = np.array([cx, cy, w, h, 0, 0, 0, 0], dtype=float)
        std = [
            2 * cls._std_weight_position * h,
            2 * cls._std_weight_position * h,
            2 * cls._std_weight_position * h,
            2 * cls._std_weight_position * h,
            10 * cls._std_weight_velocity * h,
            10 * cls._std_weight_velocity * h,
            10 * cls._std_weight_velocity * h,
            10 * cls._std_weight_velocity * h,
        ]
        cov = np.diag(np.square(std))
        return cls(mean=mean, covariance=cov)

    def predict(self) -> 'KalmanBox':
        new_mean = self._F @ self.mean
        new_cov = self._F @ self.covariance @ self._F.T
        return KalmanBox(mean=new_mean, covariance=new_cov)

    def update(self, measurement: np.ndarray) -> 'KalmanBox':
        R = np.diag(np.square([
            self._std_weight_position * self.mean[3],
            self._std_weight_position * self.mean[3],
            self._std_weight_position * self.mean[3],
            self._std_weight_position * self.mean[3],
        ]))
        S = self._H @ self.covariance @ self._H.T + R
        K = self.covariance @ self._H.T @ np.linalg.inv(S)
        new_mean = self.mean + K @ (measurement - self._H @ self.mean)
        new_cov = (np.eye(8) - K @ self._H) @ self.covariance
        return KalmanBox(mean=new_mean, covariance=new_cov)

    @property
    def bbox(self) -> np.ndarray:
        """Return [x1, y1, x2, y2]."""
        cx, cy, w, h = self.mean[:4]
        return np.array([cx - w/2, cy - h/2, cx + w/2, cy + h/2])

    @property
    def tlwh(self) -> np.ndarray:
        """Return [x1, y1, w, h]."""
        b = self.bbox
        return np.array([b[0], b[1], b[2]-b[0], b[3]-b[1]])


# ── Track ─────────────────────────────────────────────────────────────────────

class Track:
    _id_counter = 0

    def __init__(self, detection, frame_id: int, is_staff: bool = False):
        Track._id_counter += 1
        self.track_id = Track._id_counter
        self.visitor_id = f"VIS_{uuid.uuid4().hex[:6]}"

        self.state = TrackState.TENTATIVE
        self.hits = 1
        self.age = 1
        self.time_since_update = 0
        self.frame_id = frame_id
        self.start_frame = frame_id
        self.is_staff = is_staff

        cx, cy, w, h = detection['bbox_cxcywh']
        self.kalman = KalmanBox.initiate(np.array([cx, cy, w, h]))

        # Appearance embedding for Re-ID
        self.features = []
        if detection.get('embedding') is not None:
            self.features.append(detection['embedding'])

        # Trajectory history [(frame, cx, cy)]
        self.trajectory = [(frame_id, cx, cy)]
        self.confidence = detection.get('confidence', 1.0)

        # Zone tracking
        self.current_zone: Optional[str] = None
        self.zone_entry_frame: Optional[int] = None

        # Session events emitted
        self.events_emitted = []
        self.session_seq = 0

    def predict(self):
        self.kalman = self.kalman.predict()
        self.age += 1
        self.time_since_update += 1

    def update(self, detection, frame_id: int):
        cx, cy, w, h = detection['bbox_cxcywh']
        self.kalman = self.kalman.update(np.array([cx, cy, w, h]))
        self.hits += 1
        self.time_since_update = 0
        self.frame_id = frame_id
        self.confidence = detection.get('confidence', self.confidence)
        self.trajectory.append((frame_id, cx, cy))

        if detection.get('embedding') is not None:
            self.features.append(detection['embedding'])
            if len(self.features) > 50:
                self.features = self.features[-50:]

        if self.state == TrackState.TENTATIVE and self.hits >= 3:
            self.state = TrackState.CONFIRMED

    @property
    def bbox_xyxy(self) -> np.ndarray:
        return self.kalman.bbox

    @property
    def mean_embedding(self) -> Optional[np.ndarray]:
        if not self.features:
            return None
        return np.mean(self.features, axis=0)

    def next_seq(self) -> int:
        self.session_seq += 1
        return self.session_seq

    def mark_lost(self):
        self.state = TrackState.LOST

    def mark_removed(self):
        self.state = TrackState.REMOVED


# ── IoU helpers ───────────────────────────────────────────────────────────────

def iou_matrix(tracks: list, detections: list) -> np.ndarray:
    if not tracks or not detections:
        return np.zeros((len(tracks), len(detections)))
    t_boxes = np.array([t.bbox_xyxy for t in tracks])
    d_boxes = np.array([d['bbox_xyxy'] for d in detections])

    # Intersection
    ix1 = np.maximum(t_boxes[:, None, 0], d_boxes[None, :, 0])
    iy1 = np.maximum(t_boxes[:, None, 1], d_boxes[None, :, 1])
    ix2 = np.minimum(t_boxes[:, None, 2], d_boxes[None, :, 2])
    iy2 = np.minimum(t_boxes[:, None, 3], d_boxes[None, :, 3])

    inter = np.maximum(0, ix2 - ix1) * np.maximum(0, iy2 - iy1)

    t_area = (t_boxes[:, 2] - t_boxes[:, 0]) * (t_boxes[:, 3] - t_boxes[:, 1])
    d_area = (d_boxes[:, 2] - d_boxes[:, 0]) * (d_boxes[:, 3] - d_boxes[:, 1])
    union = t_areas = t_area[:, None] + d_area[None, :] - inter

    return inter / (union + 1e-6)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def linear_assignment(cost_matrix: np.ndarray):
    """Greedy assignment — good enough for retail densities."""
    matched = []
    unmatched_rows = list(range(cost_matrix.shape[0]))
    unmatched_cols = list(range(cost_matrix.shape[1]))

    if cost_matrix.size == 0:
        return matched, unmatched_rows, unmatched_cols

    # Sort by cost
    pairs = []
    for r in range(cost_matrix.shape[0]):
        for c in range(cost_matrix.shape[1]):
            pairs.append((cost_matrix[r, c], r, c))
    pairs.sort()

    used_r, used_c = set(), set()
    for cost, r, c in pairs:
        if r not in used_r and c not in used_c:
            matched.append((r, c))
            used_r.add(r)
            used_c.add(c)

    unmatched_rows = [r for r in range(cost_matrix.shape[0]) if r not in used_r]
    unmatched_cols = [c for c in range(cost_matrix.shape[1]) if c not in used_c]
    return matched, unmatched_rows, unmatched_cols


# ── ByteTracker ───────────────────────────────────────────────────────────────

class ByteTracker:
    """
    ByteTrack-inspired multi-object tracker adapted for retail CCTV.

    Key additions:
    - Re-ID gallery for re-entry detection (same person, new session)
    - Staff classification propagation
    - Zone assignment via polygon containment
    """

    def __init__(
        self,
        track_thresh: float = 0.5,
        match_thresh: float = 0.8,
        max_time_lost: int = 45,  # frames before track is removed
        reid_thresh: float = 0.65,
        reid_gallery_size: int = 200,
    ):
        self.track_thresh = track_thresh
        self.match_thresh = match_thresh
        self.max_time_lost = max_time_lost
        self.reid_thresh = reid_thresh
        self.reid_gallery_size = reid_gallery_size

        self.tracked_tracks: list[Track] = []
        self.lost_tracks: list[Track] = []
        self.removed_tracks: list[Track] = []

        # Re-ID gallery: visitor_id → mean embedding (for re-entry detection)
        self.reid_gallery: dict[str, np.ndarray] = {}

        self.frame_id = 0

    def update(self, detections: list[dict]) -> tuple[list[Track], list[str]]:
        """
        Process one frame of detections.

        Args:
            detections: list of {bbox_xyxy, bbox_cxcywh, confidence, is_staff, embedding}

        Returns:
            (active_tracks, reentry_visitor_ids)
        """
        self.frame_id += 1
        reentry_ids = []

        # Split by confidence
        high_dets = [d for d in detections if d['confidence'] >= self.track_thresh]
        low_dets  = [d for d in detections if d['confidence'] <  self.track_thresh]

        # Predict all existing tracks
        for t in self.tracked_tracks + self.lost_tracks:
            t.predict()

        confirmed = [t for t in self.tracked_tracks if t.state == TrackState.CONFIRMED]
        tentative = [t for t in self.tracked_tracks if t.state == TrackState.TENTATIVE]

        # ── Step 1: Match high-conf dets to confirmed tracks ──────────────
        matched1, unmatched_tracks1, unmatched_dets1 = self._match(
            confirmed, high_dets, threshold=self.match_thresh
        )
        for ti, di in matched1:
            confirmed[ti].update(high_dets[di], self.frame_id)

        # ── Step 2: Match remaining dets to tentative + remaining confirmed
        remaining_tracks = [confirmed[i] for i in unmatched_tracks1] + tentative
        remaining_dets = [high_dets[i] for i in unmatched_dets1]
        matched2, unmatched_tracks2, unmatched_dets2 = self._match(
            remaining_tracks, remaining_dets, threshold=0.5
        )
        for ti, di in matched2:
            remaining_tracks[ti].update(remaining_dets[di], self.frame_id)

        # ── Step 3: Match lost tracks to low-conf dets ────────────────────
        lost_candidate = [t for t in self.lost_tracks]
        if low_dets:
            matched3, _, _ = self._match(lost_candidate, low_dets, threshold=0.5)
            for ti, di in matched3:
                lost_candidate[ti].update(low_dets[di], self.frame_id)
                lost_candidate[ti].state = TrackState.CONFIRMED
                self.tracked_tracks.append(lost_candidate[ti])
                self.lost_tracks.remove(lost_candidate[ti])

        # ── Step 4: Mark unmatched confirmed tracks as lost ────────────────
        all_unmatched = (
            [confirmed[i] for i in unmatched_tracks1
             if confirmed[i] not in [remaining_tracks[j] for j, _ in matched2]]
            + [remaining_tracks[i] for i in unmatched_tracks2]
        )
        for t in all_unmatched:
            if t.state != TrackState.LOST:
                t.mark_lost()
                if t not in self.lost_tracks:
                    self.lost_tracks.append(t)
                    # Add to Re-ID gallery when track is lost (= potential exiter)
                    if t.mean_embedding is not None:
                        self.reid_gallery[t.visitor_id] = t.mean_embedding
                        # Cap gallery size
                        if len(self.reid_gallery) > self.reid_gallery_size:
                            oldest = next(iter(self.reid_gallery))
                            del self.reid_gallery[oldest]

        # ── Step 5: Init new tracks for unmatched high-conf dets ─────────
        for di in unmatched_dets2:
            det = remaining_dets[di]
            if det['confidence'] < self.track_thresh:
                continue

            # Re-ID check: is this person already in our gallery?
            reid_match = self._reid_check(det)
            if reid_match:
                # Re-entry detected
                new_track = Track(det, self.frame_id, is_staff=det.get('is_staff', False))
                new_track.visitor_id = reid_match  # keep same visitor_id
                new_track.state = TrackState.CONFIRMED
                self.tracked_tracks.append(new_track)
                reentry_ids.append(reid_match)
            else:
                new_track = Track(det, self.frame_id, is_staff=det.get('is_staff', False))
                self.tracked_tracks.append(new_track)

        # ── Expire lost tracks ────────────────────────────────────────────
        still_lost = []
        for t in self.lost_tracks:
            if t.time_since_update > self.max_time_lost:
                t.mark_removed()
                self.removed_tracks.append(t)
            else:
                still_lost.append(t)
        self.lost_tracks = still_lost

        # Cleanup tracked list
        self.tracked_tracks = [
            t for t in self.tracked_tracks
            if t.state != TrackState.REMOVED
        ]

        active = [t for t in self.tracked_tracks if t.state == TrackState.CONFIRMED]
        return active, reentry_ids

    def _match(
        self, tracks: list, detections: list, threshold: float
    ) -> tuple:
        if not tracks or not detections:
            return [], list(range(len(tracks))), list(range(len(detections)))

        iou = iou_matrix(tracks, detections)
        cost = 1 - iou

        matched, unmatched_t, unmatched_d = linear_assignment(cost)
        # Filter by threshold
        good = [(t, d) for t, d in matched if iou[t, d] >= threshold]
        bad_t = [t for t, d in matched if iou[t, d] < threshold]
        bad_d = [d for t, d in matched if iou[t, d] < threshold]

        return good, unmatched_t + bad_t, unmatched_d + bad_d

    def _reid_check(self, detection: dict) -> Optional[str]:
        """Check gallery for a matching appearance embedding."""
        emb = detection.get('embedding')
        if emb is None or not self.reid_gallery:
            return None

        best_id, best_sim = None, 0.0
        for vid, gallery_emb in self.reid_gallery.items():
            sim = cosine_similarity(np.array(emb), gallery_emb)
            if sim > best_sim:
                best_sim = sim
                best_id = vid

        if best_sim >= self.reid_thresh:
            return best_id
        return None
