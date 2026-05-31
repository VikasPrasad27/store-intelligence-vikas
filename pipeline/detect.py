"""
detect.py — Main CCTV detection and tracking pipeline.

Processes video clips using YOLOv8 for person detection, ByteTrack for
multi-object tracking, and emits structured behavioural events.

Usage:
    python detect.py --video data/videos/STORE_BLR_002_CAM_ENTRY_01.mp4 \
                     --store STORE_BLR_002 \
                     --camera CAM_ENTRY_01 \
                     --layout data/store_layout.json \
                     --output data/output/events.jsonl \
                     [--api-url http://localhost:4000] \
                     [--realtime]
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from tqdm import tqdm
from dotenv import load_dotenv

load_dotenv()

# Pipeline modules
from tracker import ByteTracker, TrackState
from emit import EventEmitter, build_event


# ── Zone geometry helpers ─────────────────────────────────────────────────────

def point_in_polygon(point: tuple, polygon: list) -> bool:
    """Ray-casting algorithm for point-in-polygon test."""
    x, y = point
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-10) + xi):
            inside = not inside
        j = i
    return inside


def bbox_center(bbox_xyxy: np.ndarray) -> tuple:
    x1, y1, x2, y2 = bbox_xyxy
    # Use bottom-center (feet position) for zone assignment
    return ((x1 + x2) / 2, y2)


def classify_direction(track, frame_height: int) -> Optional[str]:
    """
    Determine entry vs exit direction from trajectory.
    Assumes entry camera: downward movement = entry, upward = exit.
    Returns 'ENTRY', 'EXIT', or None if unclear.
    """
    traj = track.trajectory
    if len(traj) < 5:
        return None

    # Compare first 3 vs last 3 frames
    early_y = np.mean([t[2] for t in traj[:3]])
    late_y  = np.mean([t[2] for t in traj[-3:]])
    delta = late_y - early_y

    threshold = frame_height * 0.05  # 5% of frame height
    if delta > threshold:
        return 'ENTRY'   # moving down in frame = entering store
    elif delta < -threshold:
        return 'EXIT'    # moving up in frame = leaving store
    return None


def is_staff_heuristic(track, frame_width: int, frame_height: int) -> bool:
    """
    Heuristic staff classifier:
    - Staff spend very long time in frame (> 5 min at 15fps = 4500 frames)
    - Staff move across full width repeatedly
    - Staff appear in every zone

    For production: replace with uniform-color classifier or dedicated model.
    """
    if track.hits > 4500:  # ~5 min at 15fps — very long session
        return True

    if len(track.trajectory) > 30:
        xs = [t[1] for t in track.trajectory]
        x_range = max(xs) - min(xs)
        # Staff patrol: moves across > 70% of frame width repeatedly
        if x_range > frame_width * 0.7 and track.hits > 300:
            return True

    return False


# ── Load store layout ─────────────────────────────────────────────────────────

def load_layout(layout_path: str, store_id: str, camera_id: str) -> dict:
    """Load zone definitions for given store + camera from store_layout.json."""
    try:
        with open(layout_path) as f:
            layout = json.load(f)
    except FileNotFoundError:
        print(f"[WARN] store_layout.json not found at {layout_path} — using empty zones")
        return {'zones': [], 'open_hours': {'open': '09:00', 'close': '21:00'}}

    # Find store config
    store_config = None
    if isinstance(layout, list):
        store_config = next((s for s in layout if s.get('store_id') == store_id), None)
    elif isinstance(layout, dict):
        store_config = layout.get(store_id) or layout

    if not store_config:
        return {'zones': [], 'open_hours': {'open': '09:00', 'close': '21:00'}}

    return store_config


def get_zones_for_camera(store_config: dict, camera_id: str) -> list:
    """Extract zones visible from this camera with polygon coordinates."""
    zones = []
    all_zones = store_config.get('zones', [])

    for zone in all_zones:
        # Include zones covered by this camera
        covered_by = zone.get('camera_ids', [])
        if not covered_by or camera_id in covered_by or not covered_by:
            polygon = zone.get('polygon', [])
            zones.append({
                'zone_id': zone.get('zone_id', zone.get('name', 'UNKNOWN')),
                'zone_name': zone.get('zone_name', zone.get('name', '')),
                'zone_type': zone.get('zone_type', 'floor'),
                'polygon': polygon,
                'is_billing': zone.get('zone_type') == 'billing' or 'BILLING' in zone.get('zone_id', '').upper(),
                'is_entry': zone.get('zone_type') == 'entry_exit' or 'ENTRY' in zone.get('zone_id', '').upper(),
            })

    return zones


def get_camera_type(store_config: dict, camera_id: str) -> str:
    """Return camera type from layout, falling back to camera_id naming."""
    for camera in store_config.get('cameras', []):
        if camera.get('camera_id') == camera_id:
            return camera.get('type', 'floor')

    camera_name = camera_id.lower()
    if 'entry' in camera_name:
        return 'entry'
    if 'bill' in camera_name or 'cash' in camera_name:
        return 'billing'
    return 'floor'


# ── Queue depth tracker ───────────────────────────────────────────────────────

class BillingQueueTracker:
    def __init__(self):
        self.in_queue: set = set()  # visitor_ids currently in billing zone

    def update(self, billing_visitor_ids: set) -> dict:
        """
        Update queue state.
        Returns {joined: [...], abandoned: [...], depth: int}
        """
        joined    = billing_visitor_ids - self.in_queue
        abandoned = self.in_queue - billing_visitor_ids
        self.in_queue = billing_visitor_ids
        return {
            'joined': list(joined),
            'abandoned': list(abandoned),
            'depth': len(self.in_queue),
        }


# ── Main pipeline ─────────────────────────────────────────────────────────────

def process_video(
    video_path: str,
    store_id: str,
    camera_id: str,
    layout_path: str,
    output_path: str,
    api_url: Optional[str] = None,
    realtime: bool = False,
    clip_start_time: Optional[datetime] = None,
    skip_frames: int = 2,  # process every Nth frame
    conf_thresh: float = 0.35,
):
    """
    Full detection-to-events pipeline for one video clip.

    Args:
        skip_frames: Process every N frames (2 = 7.5fps effective at 15fps source)
        conf_thresh: YOLO detection confidence threshold
    """
    print(f"\n{'='*60}")
    print(f"Processing: {video_path}")
    print(f"Store: {store_id} | Camera: {camera_id}")
    print(f"{'='*60}\n")

    # ── Load YOLOv8 ──────────────────────────────────────────────────────────
    try:
        from ultralytics import YOLO
        model = YOLO('yolov8m.pt')  # medium model — best accuracy/speed tradeoff
        print("[INFO] Loaded YOLOv8m")
    except Exception as e:
        print(f"[ERROR] Failed to load YOLO model: {e}")
        print("[INFO] Install: pip install ultralytics")
        sys.exit(1)

    # ── Open video ────────────────────────────────────────────────────────────
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"[ERROR] Cannot open video: {video_path}")
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 15.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    print(f"[INFO] Video: {frame_width}x{frame_height} @ {fps:.1f}fps, {total_frames} frames")
    print(f"[INFO] Duration: {total_frames/fps/60:.1f} min")

    # ── Setup ─────────────────────────────────────────────────────────────────
    clip_start = clip_start_time or datetime.now(timezone.utc)
    layout     = load_layout(layout_path, store_id, camera_id)
    zones      = get_zones_for_camera(layout, camera_id)
    camera_type = get_camera_type(layout, camera_id)
    tracker    = ByteTracker(track_thresh=conf_thresh, max_time_lost=int(fps * 3))
    emitter    = EventEmitter(output_path, api_url=api_url, batch_size=50)
    queue_tracker = BillingQueueTracker()

    billing_zones = [z for z in zones if z['is_billing']]
    entry_zones   = [z for z in zones if z['is_entry']]
    is_entry_cam  = camera_type == 'entry' or bool(entry_zones)
    is_billing_cam = camera_type == 'billing' or bool(billing_zones)

    # Track state between frames
    track_zones: dict[int, str] = {}      # track_id → current zone_id
    zone_entry_time: dict[int, datetime] = {}  # track_id → time entered zone
    dwell_last_emit: dict[int, datetime] = {}  # track_id → last ZONE_DWELL emit time
    exited_tracks: set = set()            # track_ids that emitted EXIT
    entry_exit_tracks: set = set()        # track_ids that emitted ENTRY/EXIT

    frame_idx = 0
    processed = 0
    total_events = 0

    pbar = tqdm(total=total_frames, desc="Processing frames", unit="fr")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        frame_idx += 1
        pbar.update(1)

        # Skip frames for performance
        if frame_idx % (skip_frames + 1) != 0:
            continue
        processed += 1

        # Compute wall-clock timestamp for this frame
        frame_offset_sec = frame_idx / fps
        frame_time = clip_start + timedelta(seconds=frame_offset_sec)

        # ── Detection ─────────────────────────────────────────────────────
        results = model(
            frame,
            classes=[0],  # class 0 = person
            conf=conf_thresh,
            verbose=False,
        )

        detections = []
        for r in results:
            for box in r.boxes:
                xyxy = box.xyxy[0].cpu().numpy()
                x1, y1, x2, y2 = xyxy
                cx = (x1 + x2) / 2
                cy = (y1 + y2) / 2
                w  = x2 - x1
                h  = y2 - y1
                conf = float(box.conf[0])

                # Simple appearance embedding: HOG-based crop descriptor
                crop = frame[int(y1):int(y2), int(x1):int(x2)]
                embedding = None
                if crop.size > 0:
                    try:
                        resized = cv2.resize(crop, (32, 64))
                        gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
                        # Simple 8×16 block histogram as lightweight embedding
                        emb = []
                        for row in range(8):
                            for col in range(4):
                                block = gray[row*8:(row+1)*8, col*8:(col+1)*8]
                                hist, _ = np.histogram(block.flatten(), bins=8, range=(0, 256))
                                emb.extend(hist.tolist())
                        embedding = np.array(emb, dtype=float)
                        # Normalise
                        norm = np.linalg.norm(embedding)
                        if norm > 0:
                            embedding = embedding / norm
                    except Exception:
                        embedding = None

                detections.append({
                    'bbox_xyxy': np.array([x1, y1, x2, y2]),
                    'bbox_cxcywh': np.array([cx, cy, w, h]),
                    'confidence': conf,
                    'is_staff': False,  # updated below
                    'embedding': embedding,
                })

        # ── Tracking ──────────────────────────────────────────────────────
        active_tracks, reentry_ids = tracker.update(detections)

        # Staff classification (per-track, based on trajectory)
        billing_visitors_this_frame = set()

        for track in active_tracks:
            # Update staff flag
            track.is_staff = is_staff_heuristic(track, frame_width, frame_height)

            feet = bbox_center(track.bbox_xyxy)

            # ── Zone assignment ────────────────────────────────────────────
            assigned_zone = None
            for zone in zones:
                poly = zone.get('polygon', [])
                if poly and point_in_polygon(feet, poly):
                    assigned_zone = zone['zone_id']
                    if zone['is_billing'] and not track.is_staff:
                        billing_visitors_this_frame.add(track.visitor_id)
                    break

            prev_zone = track_zones.get(track.track_id)

            if is_billing_cam and not track.is_staff:
                billing_visitors_this_frame.add(track.visitor_id)

            # Zone enter event
            if assigned_zone and assigned_zone != prev_zone:
                if prev_zone:
                    # ZONE_EXIT from previous zone
                    if prev_zone in zone_entry_time:
                        total_dwell = (frame_time - zone_entry_time[track.track_id]).total_seconds() * 1000
                    else:
                        total_dwell = 0

                    emitter.emit(build_event(
                        store_id=store_id,
                        camera_id=camera_id,
                        visitor_id=track.visitor_id,
                        event_type='ZONE_EXIT',
                        timestamp=frame_time,
                        zone_id=prev_zone,
                        dwell_ms=int(total_dwell),
                        is_staff=track.is_staff,
                        confidence=track.confidence,
                        session_seq=track.next_seq(),
                    ))
                    total_events += 1

                # ZONE_ENTER for new zone
                emitter.emit(build_event(
                    store_id=store_id,
                    camera_id=camera_id,
                    visitor_id=track.visitor_id,
                    event_type='ZONE_ENTER',
                    timestamp=frame_time,
                    zone_id=assigned_zone,
                    is_staff=track.is_staff,
                    confidence=track.confidence,
                    session_seq=track.next_seq(),
                ))
                total_events += 1
                track_zones[track.track_id] = assigned_zone
                zone_entry_time[track.track_id] = frame_time
                dwell_last_emit[track.track_id] = frame_time

            # ZONE_DWELL — emit every 30s of continuous presence
            elif assigned_zone and assigned_zone == prev_zone:
                last_dwell = dwell_last_emit.get(track.track_id, frame_time)
                if (frame_time - last_dwell).total_seconds() >= 30:
                    entry_t = zone_entry_time.get(track.track_id, frame_time)
                    dwell_ms = (frame_time - entry_t).total_seconds() * 1000
                    emitter.emit(build_event(
                        store_id=store_id,
                        camera_id=camera_id,
                        visitor_id=track.visitor_id,
                        event_type='ZONE_DWELL',
                        timestamp=frame_time,
                        zone_id=assigned_zone,
                        dwell_ms=int(dwell_ms),
                        is_staff=track.is_staff,
                        confidence=track.confidence,
                        session_seq=track.next_seq(),
                    ))
                    total_events += 1
                    dwell_last_emit[track.track_id] = frame_time

        # ── Re-entry events ────────────────────────────────────────────────
        for visitor_id in reentry_ids:
            emitter.emit(build_event(
                store_id=store_id,
                camera_id=camera_id,
                visitor_id=visitor_id,
                event_type='REENTRY',
                timestamp=frame_time,
                is_staff=False,
                confidence=0.8,
                session_seq=1,
            ))
            total_events += 1

        # ── Entry/Exit events (entry camera only) ─────────────────────────
        if is_entry_cam:
            for track in active_tracks:
                if (
                    track.state == TrackState.CONFIRMED
                    and track.hits >= 5
                    and track.track_id not in entry_exit_tracks
                ):
                    direction = classify_direction(track, frame_height)
                    if direction is None and track.hits >= 8:
                        direction = 'ENTRY'
                    if direction in ('ENTRY', 'EXIT') and track.track_id not in exited_tracks:
                        emitter.emit(build_event(
                            store_id=store_id,
                            camera_id=camera_id,
                            visitor_id=track.visitor_id,
                            event_type=direction,
                            timestamp=frame_time,
                            is_staff=track.is_staff,
                            confidence=track.confidence,
                            session_seq=1 if direction == 'ENTRY' else track.next_seq(),
                        ))
                        total_events += 1
                        entry_exit_tracks.add(track.track_id)
                        if direction == 'EXIT':
                            exited_tracks.add(track.track_id)

        # ── Billing queue events ───────────────────────────────────────────
        if is_billing_cam or billing_zones:
            queue_update = queue_tracker.update(billing_visitors_this_frame)

            for visitor_id in queue_update['joined']:
                emitter.emit(build_event(
                    store_id=store_id,
                    camera_id=camera_id,
                    visitor_id=visitor_id,
                    event_type='BILLING_QUEUE_JOIN',
                    timestamp=frame_time,
                    zone_id='BILLING',
                    is_staff=False,
                    confidence=0.85,
                    queue_depth=queue_update['depth'],
                    session_seq=1,
                ))
                total_events += 1

            for visitor_id in queue_update['abandoned']:
                emitter.emit(build_event(
                    store_id=store_id,
                    camera_id=camera_id,
                    visitor_id=visitor_id,
                    event_type='BILLING_QUEUE_ABANDON',
                    timestamp=frame_time,
                    zone_id='BILLING',
                    is_staff=False,
                    confidence=0.80,
                    queue_depth=queue_update['depth'],
                    session_seq=1,
                ))
                total_events += 1

        # Simulated real-time delay
        if realtime:
            time.sleep(1.0 / (fps / (skip_frames + 1)))

    pbar.close()
    cap.release()
    emitter.close()

    print(f"\n[INFO] Done. Processed {processed}/{total_frames} frames")
    print(f"[INFO] Total events emitted: {total_events}")
    print(f"[INFO] Output: {output_path}")

    return emitter.stats


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='CCTV Detection Pipeline')
    parser.add_argument('--video',   required=True,  help='Path to video file')
    parser.add_argument('--store',   required=True,  help='Store ID (e.g. STORE_BLR_002)')
    parser.add_argument('--camera',  required=True,  help='Camera ID (e.g. CAM_ENTRY_01)')
    parser.add_argument('--layout',  default='data/store_layout.json', help='Path to store_layout.json')
    parser.add_argument('--output',  default='data/output/events.jsonl', help='Output events JSONL file')
    parser.add_argument('--api-url', default=None,   help='API base URL to stream events live')
    parser.add_argument('--realtime', action='store_true', help='Simulate real-time processing speed')
    parser.add_argument('--skip',    type=int, default=2, help='Process every Nth frame (default: 2)')
    parser.add_argument('--conf',    type=float, default=0.35, help='Detection confidence threshold')
    parser.add_argument('--start-time', default=None, help='Clip start time ISO-8601 UTC')

    args = parser.parse_args()

    start_time = None
    if args.start_time:
        start_time = datetime.fromisoformat(args.start_time.replace('Z', '+00:00'))

    process_video(
        video_path=args.video,
        store_id=args.store,
        camera_id=args.camera,
        layout_path=args.layout,
        output_path=args.output,
        api_url=args.api_url,
        realtime=args.realtime,
        clip_start_time=start_time,
        skip_frames=args.skip,
        conf_thresh=args.conf,
    )
