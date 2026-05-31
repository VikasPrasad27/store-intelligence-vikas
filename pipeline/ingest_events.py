"""
ingest_events.py — Batch ingest JSONL events into the Store Intelligence API.

Used after detect.py has already written events to disk, or for replaying
historical event files.

Usage:
    python pipeline/ingest_events.py \
        --events data/output/all_events.jsonl \
        --api-url http://localhost:4000 \
        --batch-size 200
"""

import argparse
import json
import sys
import time
import requests
from pathlib import Path
from tqdm import tqdm
import os
from dotenv import load_dotenv

load_dotenv()


def ingest_file(events_path: str, api_url: str, api_key: str, batch_size: int):
    """Read JSONL events file and POST in batches to /api/events/ingest."""
    path = Path(events_path)
    if not path.exists():
        print(f"[ERROR] Events file not found: {events_path}")
        sys.exit(1)

    events = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError as e:
                    print(f"[WARN] Skipping malformed line: {e}")

    if not events:
        print("[WARN] No events found in file")
        return

    print(f"[INFO] Loaded {len(events)} events from {events_path}")

    url = f"{api_url.rstrip('/')}/api/events/ingest"
    headers = {'Content-Type': 'application/json'}
    if api_key:
        headers['X-Api-Key'] = api_key

    total_accepted = 0
    total_duplicates = 0
    total_errors = 0

    batches = [events[i:i+batch_size] for i in range(0, len(events), batch_size)]

    for batch in tqdm(batches, desc="Ingesting batches"):
        for attempt in range(3):
            try:
                resp = requests.post(
                    url,
                    json={'events': batch},
                    headers=headers,
                    timeout=30,
                )
                if resp.status_code in (200, 207):
                    data = resp.json()
                    result = data.get('result', {})
                    total_accepted   += result.get('accepted', 0)
                    total_duplicates += result.get('duplicates', 0)
                    total_errors     += len(result.get('errors', []))
                    break
                elif resp.status_code == 429:
                    print(f"\n[WARN] Rate limited — waiting 2s...")
                    time.sleep(2)
                else:
                    print(f"\n[WARN] Batch failed with {resp.status_code}: {resp.text[:200]}")
                    break
            except requests.exceptions.RequestException as e:
                if attempt == 2:
                    print(f"\n[ERROR] Batch failed after 3 attempts: {e}")
                else:
                    time.sleep(1)

    print(f"\n{'='*40}")
    print(f"Ingest complete:")
    print(f"  Accepted   : {total_accepted}")
    print(f"  Duplicates : {total_duplicates}")
    print(f"  Errors     : {total_errors}")
    print(f"{'='*40}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Batch ingest events into API')
    parser.add_argument('--events',     required=True,  help='Path to .jsonl events file')
    parser.add_argument('--api-url',    default='http://localhost:4000', help='API base URL')
    parser.add_argument('--api-key',    default=None,   help='X-Api-Key header value')
    parser.add_argument('--batch-size', type=int, default=200, help='Events per batch (max 500)')

    args = parser.parse_args()
    api_key = args.api_key or os.getenv('VISION_API_KEY', '')

    ingest_file(args.events, args.api_url, api_key, min(args.batch_size, 500))
