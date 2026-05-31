"""
emit.py — Event schema builder and emitter.

Constructs validated events from tracker output and emits them to:
  1. A JSONL file (batch output)
  2. The Intelligence API via HTTP POST (real-time mode)
"""

import uuid
import json
import os
import requests
from datetime import datetime, timezone
from typing import Optional


# ── Event builder ─────────────────────────────────────────────────────────────

def build_event(
    store_id: str,
    camera_id: str,
    visitor_id: str,
    event_type: str,
    timestamp: datetime,
    zone_id: Optional[str] = None,
    dwell_ms: int = 0,
    is_staff: bool = False,
    confidence: float = 1.0,
    queue_depth: Optional[int] = None,
    sku_zone: Optional[str] = None,
    session_seq: int = 1,
) -> dict:
    """
    Build a validated event dict matching the required output schema.
    All fields match the problem statement spec exactly.
    """
    assert event_type in {
        'ENTRY', 'EXIT', 'ZONE_ENTER', 'ZONE_EXIT',
        'ZONE_DWELL', 'BILLING_QUEUE_JOIN', 'BILLING_QUEUE_ABANDON',
        'REENTRY',
    }, f"Invalid event_type: {event_type}"

    # ENTRY/EXIT events must not have zone_id
    if event_type in ('ENTRY', 'EXIT', 'REENTRY'):
        zone_id = None

    return {
        "event_id": str(uuid.uuid4()),
        "store_id": store_id,
        "camera_id": camera_id,
        "visitor_id": visitor_id,
        "event_type": event_type,
        "timestamp": timestamp.strftime('%Y-%m-%dT%H:%M:%SZ'),
        "zone_id": zone_id,
        "dwell_ms": max(0, int(dwell_ms)),
        "is_staff": bool(is_staff),
        "confidence": round(float(confidence), 4),
        "metadata": {
            "queue_depth": int(queue_depth) if queue_depth is not None else None,
            "sku_zone": sku_zone,
            "session_seq": int(session_seq),
        },
    }


# ── Emitter ───────────────────────────────────────────────────────────────────

class EventEmitter:
    """
    Buffers events and flushes to file and/or API.
    Thread-safe for single-process use.
    """

    def __init__(
        self,
        output_path: str,
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        batch_size: int = 50,
        dry_run: bool = False,
    ):
        self.output_path = output_path
        self.api_url = api_url or os.getenv('API_BASE_URL')
        self.api_key = api_key or os.getenv('VISION_API_KEY')
        self.batch_size = batch_size
        self.dry_run = dry_run

        self._buffer: list[dict] = []
        self._total_emitted = 0
        self._total_api_sent = 0
        self._errors = 0

        # Open output file
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        self._fh = open(output_path, 'a', encoding='utf-8')

    def emit(self, event: dict):
        """Add event to buffer; flush if buffer is full."""
        self._buffer.append(event)
        if len(self._buffer) >= self.batch_size:
            self.flush()

    def flush(self):
        """Write buffered events to file and optionally to API."""
        if not self._buffer:
            return

        batch = list(self._buffer)
        self._buffer.clear()

        # Write to JSONL file
        for evt in batch:
            self._fh.write(json.dumps(evt) + '\n')
        self._fh.flush()
        self._total_emitted += len(batch)

        # Send to API if configured
        if self.api_url and not self.dry_run:
            self._send_to_api(batch)

    def _send_to_api(self, events: list[dict]):
        """POST batch to /api/events/ingest."""
        url = f"{self.api_url.rstrip('/')}/api/events/ingest"
        headers = {'Content-Type': 'application/json'}
        if self.api_key:
            headers['X-Api-Key'] = self.api_key

        try:
            resp = requests.post(
                url,
                json={'events': events},
                headers=headers,
                timeout=10,
            )
            if resp.status_code in (200, 207):
                self._total_api_sent += len(events)
            else:
                self._errors += 1
                print(f"[WARN] API ingest returned {resp.status_code}: {resp.text[:200]}")
        except requests.exceptions.RequestException as e:
            self._errors += 1
            print(f"[WARN] API ingest failed: {e}")

    def close(self):
        self.flush()
        self._fh.close()
        print(
            f"[EventEmitter] Closed. "
            f"Total emitted: {self._total_emitted}, "
            f"API sent: {self._total_api_sent}, "
            f"Errors: {self._errors}"
        )

    @property
    def stats(self) -> dict:
        return {
            'total_emitted': self._total_emitted,
            'total_api_sent': self._total_api_sent,
            'errors': self._errors,
        }
