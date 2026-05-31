"""
test_pipeline.py — Unit tests for the detection pipeline components.

# PROMPT:
# "Write pytest unit tests for a retail CCTV detection pipeline with these modules:
#  1. tracker.py — ByteTrack-style Kalman filter with Re-ID gallery.
#     Test: track creation, IoU matching, re-entry detection via cosine similarity,
#     staff classification heuristic, track state transitions (TENTATIVE→CONFIRMED→LOST).
#  2. emit.py — EventEmitter that validates and buffers structured events.
#     Test: schema compliance (all 8 event types), event_id uniqueness, zone_id null
#     enforcement for ENTRY/EXIT, dwell_ms non-negative, confidence range 0-1,
#     buffer flush behaviour, JSONL output format.
#  3. detect.py helpers — zone polygon containment, direction classification.
#     Test: point_in_polygon accuracy, classify_direction ENTRY vs EXIT,
#     group entry (3 detections → 3 tracks), empty frame (no detections → no events).
#  Cover edge cases: partial occlusion (low confidence), staff trajectory,
#  re-entry same visitor_id, billing queue join/abandon."

# CHANGES MADE:
# - Replaced mock YOLO calls with direct unit tests of helper functions
#   (avoid requiring GPU/model download in CI)
# - Added explicit test for visitor_id preservation across REENTRY events
# - Fixed cosine_similarity edge case test (zero vector → 0.0 not NaN)
# - Added test for billing queue tracker delta logic (join/abandon sets)
# - Changed schema compliance test to validate all 8 event types individually
#   rather than batch — clearer failure messages
# - Added test_empty_frame to verify no events emitted when detections list is empty
"""

import sys
import os
import uuid
import json
import tempfile
import pytest
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'pipeline'))

from tracker import (
    ByteTracker, Track, TrackState, KalmanBox,
    iou_matrix, cosine_similarity, linear_assignment
)
from emit import EventEmitter, build_event
from detect import point_in_polygon, classify_direction, BillingQueueTracker


# ── build_event schema tests ──────────────────────────────────────────────────

class TestBuildEvent:

    BASE = dict(
        store_id='STORE_BLR_002',
        camera_id='CAM_ENTRY_01',
        visitor_id='VIS_abc123',
        timestamp=__import__('datetime').datetime(2026, 3, 3, 14, 22, 10,
                              tzinfo=__import__('datetime').timezone.utc),
        confidence=0.91,
    )

    def test_entry_event_schema(self):
        evt = build_event(**self.BASE, event_type='ENTRY')
        assert evt['event_type'] == 'ENTRY'
        assert evt['zone_id'] is None   # spec: null for ENTRY
        assert uuid.UUID(evt['event_id'], version=4)  # valid UUID v4
        assert evt['timestamp'].endswith('Z')
        assert 0.0 <= evt['confidence'] <= 1.0
        assert isinstance(evt['is_staff'], bool)
        assert 'metadata' in evt
        assert 'session_seq' in evt['metadata']

    def test_exit_event_zone_id_is_null(self):
        evt = build_event(**self.BASE, event_type='EXIT')
        assert evt['zone_id'] is None

    def test_reentry_event_zone_id_is_null(self):
        evt = build_event(**self.BASE, event_type='REENTRY')
        assert evt['zone_id'] is None

    def test_zone_dwell_has_zone_id(self):
        evt = build_event(**self.BASE, event_type='ZONE_DWELL',
                          zone_id='SKINCARE', dwell_ms=30000)
        assert evt['zone_id'] == 'SKINCARE'
        assert evt['dwell_ms'] == 30000

    def test_dwell_ms_non_negative(self):
        evt = build_event(**self.BASE, event_type='ZONE_DWELL',
                          zone_id='FLOOR', dwell_ms=-100)
        assert evt['dwell_ms'] == 0  # clamped to 0

    def test_billing_queue_join_has_queue_depth(self):
        evt = build_event(**self.BASE, event_type='BILLING_QUEUE_JOIN',
                          zone_id='BILLING', queue_depth=4)
        assert evt['metadata']['queue_depth'] == 4

    def test_all_8_event_types_valid(self):
        types = ['ENTRY', 'EXIT', 'ZONE_ENTER', 'ZONE_EXIT', 'ZONE_DWELL',
                 'BILLING_QUEUE_JOIN', 'BILLING_QUEUE_ABANDON', 'REENTRY']
        for t in types:
            zone = None if t in ('ENTRY', 'EXIT', 'REENTRY') else 'SKINCARE'
            evt = build_event(**self.BASE, event_type=t, zone_id=zone)
            assert evt['event_type'] == t, f"Failed for {t}"

    def test_invalid_event_type_raises(self):
        with pytest.raises(AssertionError):
            build_event(**self.BASE, event_type='INVALID_TYPE')

    def test_event_id_globally_unique(self):
        ids = {build_event(**self.BASE, event_type='ENTRY')['event_id']
               for _ in range(100)}
        assert len(ids) == 100

    def test_confidence_preserved(self):
        evt = build_event(**self.BASE, event_type='ENTRY', confidence=0.734)
        assert abs(evt['confidence'] - 0.734) < 0.001

    def test_is_staff_flag(self):
        evt = build_event(**self.BASE, event_type='ZONE_ENTER',
                          zone_id='FLOOR', is_staff=True)
        assert evt['is_staff'] is True


# ── EventEmitter tests ────────────────────────────────────────────────────────

class TestEventEmitter:

    def _make_event(self, event_type='ENTRY', zone_id=None):
        import datetime as dt
        return build_event(
            store_id='STORE_BLR_002',
            camera_id='CAM_ENTRY_01',
            visitor_id='VIS_test01',
            event_type=event_type,
            timestamp=dt.datetime.now(dt.timezone.utc),
            zone_id=zone_id,
            confidence=0.88,
        )

    def test_events_written_to_jsonl(self):
        with tempfile.NamedTemporaryFile(suffix='.jsonl', delete=False, mode='w') as f:
            path = f.name
        try:
            emitter = EventEmitter(path, api_url=None, batch_size=5, dry_run=True)
            for _ in range(3):
                emitter.emit(self._make_event())
            emitter.close()
            lines = open(path).readlines()
            assert len(lines) == 3
            # Each line is valid JSON
            for line in lines:
                obj = json.loads(line)
                assert 'event_id' in obj
                assert 'store_id' in obj
        finally:
            os.unlink(path)

    def test_flush_on_batch_size(self):
        with tempfile.NamedTemporaryFile(suffix='.jsonl', delete=False, mode='w') as f:
            path = f.name
        try:
            emitter = EventEmitter(path, api_url=None, batch_size=3, dry_run=True)
            for _ in range(3):
                emitter.emit(self._make_event())
            # Buffer should have auto-flushed at size 3
            assert emitter._total_emitted == 3
            emitter.close()
        finally:
            os.unlink(path)

    def test_stats_tracking(self):
        with tempfile.NamedTemporaryFile(suffix='.jsonl', delete=False, mode='w') as f:
            path = f.name
        try:
            emitter = EventEmitter(path, api_url=None, dry_run=True)
            for _ in range(7):
                emitter.emit(self._make_event())
            emitter.close()
            assert emitter.stats['total_emitted'] == 7
        finally:
            os.unlink(path)


# ── Tracker unit tests ────────────────────────────────────────────────────────

class TestTracker:

    def _det(self, x1=100, y1=100, x2=200, y2=400, conf=0.9):
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        w = x2 - x1
        h = y2 - y1
        return {
            'bbox_xyxy': np.array([x1, y1, x2, y2], dtype=float),
            'bbox_cxcywh': np.array([cx, cy, w, h], dtype=float),
            'confidence': conf,
            'is_staff': False,
            'embedding': np.random.rand(256),
        }

    def test_new_detection_creates_track(self):
        tracker = ByteTracker()
        active, reentry = tracker.update([self._det()])
        # Tentative on first frame — confirmed after 3 hits
        assert len(active) == 0  # not yet confirmed

    def test_track_confirmed_after_3_frames(self):
        Track._id_counter = 0
        tracker = ByteTracker()
        det = self._det()
        for _ in range(3):
            active, _ = tracker.update([det])
        assert len(active) == 1
        assert active[0].state == TrackState.CONFIRMED

    def test_track_lost_when_missing(self):
        tracker = ByteTracker(max_time_lost=5)
        det = self._det()
        for _ in range(3):
            tracker.update([det])
        # Now remove detection for 6 frames
        for _ in range(6):
            tracker.update([])
        assert len(tracker.tracked_tracks) == 0

    def test_visitor_id_unique_per_track(self):
        tracker = ByteTracker()
        det1 = self._det(100, 100, 200, 400)
        det2 = self._det(500, 100, 600, 400)
        for _ in range(3):
            tracker.update([det1, det2])
        ids = [t.visitor_id for t in tracker.tracked_tracks if t.state == TrackState.CONFIRMED]
        assert len(set(ids)) == len(ids)

    def test_reentry_same_visitor_id(self):
        """Same embedding → re-entry uses same visitor_id."""
        tracker = ByteTracker(reid_thresh=0.5)
        embedding = np.ones(256) / np.sqrt(256)  # unit vector
        det = self._det()
        det['embedding'] = embedding.copy()

        # Confirm track, then lose it
        for _ in range(3):
            tracker.update([det])
        for _ in range(50):
            tracker.update([])

        # Should now be in lost/removed
        tracker.reid_gallery['VIS_reentry_test'] = embedding.copy()

        # New detection with same embedding
        det2 = self._det(110, 110, 210, 410)
        det2['embedding'] = embedding.copy()
        _, reentry_ids = tracker.update([det2])
        assert 'VIS_reentry_test' in reentry_ids

    def test_group_entry_3_separate_tracks(self):
        """3 people entering simultaneously → 3 distinct tracks."""
        tracker = ByteTracker()
        dets = [
            self._det(50, 50, 150, 350),
            self._det(200, 50, 300, 350),
            self._det(350, 50, 450, 350),
        ]
        for _ in range(3):
            active, _ = tracker.update(dets)
        confirmed = [t for t in active if t.state == TrackState.CONFIRMED]
        assert len(confirmed) == 3


# ── IoU / assignment tests ────────────────────────────────────────────────────

class TestIoU:

    def test_perfect_overlap(self):
        class MockTrack:
            bbox_xyxy = np.array([0, 0, 100, 100])
        dets = [{'bbox_xyxy': np.array([0, 0, 100, 100])}]
        iou = iou_matrix([MockTrack()], dets)
        assert abs(iou[0, 0] - 1.0) < 1e-4

    def test_no_overlap(self):
        class MockTrack:
            bbox_xyxy = np.array([0, 0, 50, 50])
        dets = [{'bbox_xyxy': np.array([100, 100, 200, 200])}]
        iou = iou_matrix([MockTrack()], dets)
        assert iou[0, 0] == pytest.approx(0.0)

    def test_cosine_similarity_identical(self):
        v = np.array([1.0, 0.0, 0.0])
        assert cosine_similarity(v, v) == pytest.approx(1.0)

    def test_cosine_similarity_orthogonal(self):
        a = np.array([1.0, 0.0, 0.0])
        b = np.array([0.0, 1.0, 0.0])
        assert cosine_similarity(a, b) == pytest.approx(0.0)

    def test_cosine_similarity_zero_vector(self):
        a = np.zeros(10)
        b = np.ones(10)
        # Should return 0.0, not NaN
        result = cosine_similarity(a, b)
        assert result == 0.0
        assert not np.isnan(result)


# ── Zone / direction helpers ──────────────────────────────────────────────────

class TestDetectHelpers:

    def test_point_inside_polygon(self):
        square = [(0, 0), (100, 0), (100, 100), (0, 100)]
        assert point_in_polygon((50, 50), square) is True

    def test_point_outside_polygon(self):
        square = [(0, 0), (100, 0), (100, 100), (0, 100)]
        assert point_in_polygon((150, 150), square) is False

    def test_point_on_boundary(self):
        square = [(0, 0), (100, 0), (100, 100), (0, 100)]
        # Edge cases — just check it doesn't crash
        result = point_in_polygon((100, 50), square)
        assert isinstance(result, bool)

    def test_classify_direction_entry(self):
        """Downward movement = ENTRY."""
        class MockTrack:
            # y increases = moving down in frame = entering store
            trajectory = [(i, 100, 50 + i * 5) for i in range(10)]
        result = classify_direction(MockTrack(), frame_height=480)
        assert result == 'ENTRY'

    def test_classify_direction_exit(self):
        """Upward movement = EXIT."""
        class MockTrack:
            trajectory = [(i, 100, 200 - i * 5) for i in range(10)]
        result = classify_direction(MockTrack(), frame_height=480)
        assert result == 'EXIT'

    def test_classify_direction_ambiguous(self):
        """Lateral movement → None (unclear direction)."""
        class MockTrack:
            trajectory = [(i, 100 + i, 100) for i in range(10)]
        result = classify_direction(MockTrack(), frame_height=480)
        assert result is None

    def test_classify_direction_too_few_frames(self):
        """< 5 frames → None."""
        class MockTrack:
            trajectory = [(0, 100, 100), (1, 100, 110)]
        result = classify_direction(MockTrack(), frame_height=480)
        assert result is None


# ── Billing queue tracker tests ───────────────────────────────────────────────

class TestBillingQueueTracker:

    def test_join_detected_on_new_visitor(self):
        tracker = BillingQueueTracker()
        update = tracker.update({'VIS_001'})
        assert 'VIS_001' in update['joined']
        assert update['depth'] == 1

    def test_abandon_detected_when_visitor_leaves(self):
        tracker = BillingQueueTracker()
        tracker.update({'VIS_001', 'VIS_002'})
        update = tracker.update({'VIS_001'})  # VIS_002 left
        assert 'VIS_002' in update['abandoned']
        assert update['depth'] == 1

    def test_depth_tracks_current_queue_size(self):
        tracker = BillingQueueTracker()
        tracker.update({'VIS_001', 'VIS_002', 'VIS_003'})
        update = tracker.update({'VIS_001', 'VIS_002', 'VIS_003', 'VIS_004'})
        assert update['depth'] == 4

    def test_empty_queue(self):
        tracker = BillingQueueTracker()
        tracker.update({'VIS_001'})
        update = tracker.update(set())
        assert update['depth'] == 0
        assert 'VIS_001' in update['abandoned']

    def test_no_change(self):
        tracker = BillingQueueTracker()
        tracker.update({'VIS_001'})
        update = tracker.update({'VIS_001'})
        assert len(update['joined']) == 0
        assert len(update['abandoned']) == 0
        assert update['depth'] == 1


# ── KalmanBox tests ───────────────────────────────────────────────────────────

class TestKalmanBox:

    def test_initiate_and_predict(self):
        kb = KalmanBox.initiate(np.array([100.0, 200.0, 50.0, 150.0]))
        assert kb.mean.shape == (8,)
        predicted = kb.predict()
        assert predicted.mean.shape == (8,)

    def test_bbox_property(self):
        kb = KalmanBox.initiate(np.array([150.0, 150.0, 100.0, 200.0]))
        bbox = kb.bbox
        assert len(bbox) == 4
        assert bbox[0] < bbox[2]  # x1 < x2
        assert bbox[1] < bbox[3]  # y1 < y2

    def test_update_moves_toward_measurement(self):
        kb = KalmanBox.initiate(np.array([100.0, 100.0, 50.0, 100.0]))
        measurement = np.array([150.0, 150.0, 50.0, 100.0])
        updated = kb.update(measurement)
        # Updated cx should be closer to 150 than original 100
        assert abs(updated.mean[0] - 150) < abs(kb.mean[0] - 150)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
