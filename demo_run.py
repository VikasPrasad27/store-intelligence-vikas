#!/usr/bin/env python3
"""
demo_run.py — Fast demo pipeline for all 5 cameras.

Processes only the first N seconds of each clip at high frame skip.
Perfect for live demo: shows real detection output in ~3-5 minutes total.

Usage:
    python demo_run.py --api-url https://store-intelligence-api-jcib.onrender.com
    python demo_run.py --api-url http://localhost:4000 --seconds 90
    python demo_run.py --dry-run   # just show what would run, no actual processing
"""

import argparse
import subprocess
import sys
import os
import time
import json
import requests
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

STORE_ID   = "STORE_BLR_BRIGADE"
VIDEOS_DIR = "data/videos"
OUTPUT_DIR = "data/output"
LAYOUT     = "data/store_layout.json"

# Camera config — matches your actual files
CAMERAS = [
    {
        "file":       "CAM 1.mp4",
        "camera_id":  "CAM_1",
        "type":       "entry",
        "start_time": "2026-04-10T12:00:00Z",
        "desc":       "Entry/Exit threshold",
    },
    {
        "file":       "CAM 4.mp4",
        "camera_id":  "CAM_4",
        "type":       "billing",
        "start_time": "2026-04-10T12:00:00Z",
        "desc":       "Billing / Cash Counter",
    },
    {
        "file":       "CAM 2.mp4",
        "camera_id":  "CAM_2",
        "type":       "floor",
        "start_time": "2026-04-10T12:00:00Z",
        "desc":       "Floor — FOH / Fragrance / Nail",
    },
    {
        "file":       "CAM 3.mp4",
        "camera_id":  "CAM_3",
        "type":       "floor",
        "start_time": "2026-04-10T12:00:00Z",
        "desc":       "Floor — Skin / Makeup",
    },
    {
        "file":       "CAM 5.mp4",
        "camera_id":  "CAM_5",
        "type":       "floor",
        "start_time": "2026-04-10T12:00:00Z",
        "desc":       "Floor — Wall Brands",
    },
]

# ── Helpers ───────────────────────────────────────────────────────────────────

BOLD   = "\033[1m"
GREEN  = "\033[92m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RED    = "\033[91m"
DIM    = "\033[2m"
RESET  = "\033[0m"

def log(msg, color=RESET):     print(f"{color}{msg}{RESET}", flush=True)
def ok(msg):                   log(f"  ✅  {msg}", GREEN)
def warn(msg):                 log(f"  ⚠️   {msg}", YELLOW)
def info(msg):                 log(f"  ℹ️   {msg}", CYAN)
def err(msg):                  log(f"  ❌  {msg}", RED)
def header(msg):               log(f"\n{BOLD}{'─'*60}\n  {msg}\n{'─'*60}{RESET}")

def trim_video(src: str, dst: str, seconds: int) -> bool:
    """Use ffmpeg to extract first N seconds — fast, no re-encode."""
    cmd = [
        "ffmpeg", "-y",
        "-i", src,
        "-t", str(seconds),
        "-c", "copy",          # stream copy = near-instant
        dst,
        "-loglevel", "error",
    ]
    result = subprocess.run(cmd, capture_output=True)
    return result.returncode == 0

def check_ffmpeg() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False

def check_api(api_url: str) -> bool:
    try:
        r = requests.get(f"{api_url.rstrip('/')}/api/health", timeout=10)
        return r.status_code == 200
    except Exception:
        return False

def run_detect(video_path: str, camera: dict, output_path: str,
               api_url: str, skip: int, conf: float,
               start_time: str, dry_run: bool) -> bool:
    cmd = [
        sys.executable, "pipeline/detect.py",
        "--video",      video_path,
        "--store",      STORE_ID,
        "--camera",     camera["camera_id"],
        "--layout",     LAYOUT,
        "--output",     output_path,
        "--api-url",    api_url,
        "--skip",       str(skip),
        "--conf",       str(conf),
        "--start-time", start_time,
    ]

    if dry_run:
        info(f"[DRY RUN] Would run: {' '.join(cmd)}")
        return True

    result = subprocess.run(cmd)
    return result.returncode == 0

def ingest_pos(api_url: str, dry_run: bool):
    csv = "data/pos_transactions.csv"
    if not Path(csv).exists():
        warn("pos_transactions.csv not found — skipping POS ingest")
        return
    if dry_run:
        info(f"[DRY RUN] Would ingest POS from {csv}")
        return
    result = subprocess.run([
        sys.executable, "pipeline/ingest_pos.py",
        "--csv", csv,
        "--api-url", api_url,
    ])
    if result.returncode == 0:
        ok("POS transactions ingested")
    else:
        warn("POS ingest failed — check API is running")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fast demo pipeline")
    parser.add_argument("--api-url",  default="https://store-intelligence-api-jcib.onrender.com",
                        help="API base URL")
    parser.add_argument("--seconds",  type=int,   default=120,
                        help="Seconds of each clip to process (default: 120 = 2 min)")
    parser.add_argument("--skip",     type=int,   default=4,
                        help="Process every Nth frame (default: 4 = ~3fps effective)")
    parser.add_argument("--conf",     type=float, default=0.35,
                        help="YOLO detection confidence threshold")
    parser.add_argument("--cam",      type=str,   default=None,
                        help="Process only one camera, e.g. --cam CAM_1")
    parser.add_argument("--dry-run",  action="store_true",
                        help="Show what would run without executing")
    parser.add_argument("--no-trim",  action="store_true",
                        help="Process full videos (slow — not for demo)")
    args = parser.parse_args()

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs("data/videos/trimmed", exist_ok=True)

    # ── Banner ────────────────────────────────────────────────────────────────
    print(f"""
{BOLD}{CYAN}╔══════════════════════════════════════════════════════════╗
║   Purplle Store Intelligence — Demo Pipeline             ║
║   Brigade Road Bangalore · STORE_BLR_BRIGADE             ║
╚══════════════════════════════════════════════════════════╝{RESET}

  API URL   : {args.api_url}
  Clip trim : {args.seconds}s per camera (out of 20 min)
  Frame skip: every {args.skip} frames (~{15/(args.skip+1):.1f} fps effective)
  Confidence: {args.conf}
  Dry run   : {args.dry_run}
""")

    # ── Pre-flight checks ─────────────────────────────────────────────────────
    header("Pre-flight checks")

    has_ffmpeg = check_ffmpeg()
    if has_ffmpeg:
        ok("ffmpeg found — will trim clips for speed")
    else:
        warn("ffmpeg not found — processing full clips (slower)")
        warn("Install: brew install ffmpeg  OR  sudo apt install ffmpeg")
        args.no_trim = True

    if not args.dry_run:
        info(f"Checking API at {args.api_url} ...")
        if check_api(args.api_url):
            ok("API is live and healthy")
        else:
            err("API not reachable — start with: docker compose up -d")
            err("Or check your Render URL is awake (may take 30s cold start)")
            sys.exit(1)

    # ── Filter cameras ────────────────────────────────────────────────────────
    cameras = CAMERAS
    if args.cam:
        cameras = [c for c in CAMERAS if c["camera_id"] == args.cam]
        if not cameras:
            err(f"Camera {args.cam} not found. Options: {[c['camera_id'] for c in CAMERAS]}")
            sys.exit(1)

    # ── Process each camera ───────────────────────────────────────────────────
    total_start = time.time()
    results = []
    combined_output = f"{OUTPUT_DIR}/demo_events.jsonl"
    open(combined_output, "w").close()  # clear/create

    for i, cam in enumerate(cameras):
        src_path = f"{VIDEOS_DIR}/{cam['file']}"
        cam_output = f"{OUTPUT_DIR}/{cam['camera_id']}_demo_events.jsonl"

        header(f"Camera {i+1}/{len(cameras)}: {cam['camera_id']} — {cam['desc']}")

        # Check video exists
        if not Path(src_path).exists():
            warn(f"Video not found: {src_path} — skipping")
            results.append({"cam": cam["camera_id"], "status": "skipped"})
            continue

        info(f"Source: {src_path}")

        # Trim video using ffmpeg (near-instant)
        if not args.no_trim:
            trimmed_path = f"data/videos/trimmed/{cam['camera_id']}_trim{args.seconds}s.mp4"
            if not Path(trimmed_path).exists() or os.path.getsize(trimmed_path) < 1000:
                info(f"Trimming to {args.seconds}s with ffmpeg...")
                t0 = time.time()
                if trim_video(src_path, trimmed_path, args.seconds):
                    ok(f"Trimmed in {time.time()-t0:.1f}s → {trimmed_path}")
                else:
                    warn("ffmpeg trim failed — using full video")
                    trimmed_path = src_path
            else:
                ok(f"Using cached trim: {trimmed_path}")
            process_path = trimmed_path
        else:
            process_path = src_path

        # Run detection
        info(f"Running YOLOv8m + ByteTrack...")
        t0 = time.time()
        success = run_detect(
            video_path=process_path,
            camera=cam,
            output_path=cam_output,
            api_url=args.api_url,
            skip=args.skip,
            conf=args.conf,
            start_time=cam["start_time"],
            dry_run=args.dry_run,
        )
        elapsed = time.time() - t0

        if success:
            # Count events
            if not args.dry_run and Path(cam_output).exists():
                event_count = sum(1 for _ in open(cam_output))
                ok(f"Done in {elapsed:.1f}s — {event_count} events emitted")
                # Append to combined
                with open(cam_output) as fin, open(combined_output, "a") as fout:
                    fout.write(fin.read())
            else:
                ok(f"Done in {elapsed:.1f}s")
            results.append({"cam": cam["camera_id"], "status": "ok", "elapsed": elapsed})
        else:
            err(f"Detection failed for {cam['camera_id']}")
            results.append({"cam": cam["camera_id"], "status": "failed"})

    # ── POS ingest ────────────────────────────────────────────────────────────
    header("Ingesting POS transactions")
    ingest_pos(args.api_url, args.dry_run)

    # ── Summary ───────────────────────────────────────────────────────────────
    total_elapsed = time.time() - total_start
    total_events  = 0
    if not args.dry_run and Path(combined_output).exists():
        total_events = sum(1 for _ in open(combined_output))

    header("Summary")
    print(f"  {'Camera':<12} {'Status':<10} {'Time':>8}")
    print(f"  {'──────':<12} {'──────':<10} {'────':>8}")
    for r in results:
        status_color = GREEN if r["status"] == "ok" else (YELLOW if r["status"] == "skipped" else RED)
        elapsed_str = f"{r.get('elapsed', 0):.1f}s" if "elapsed" in r else "—"
        print(f"  {r['cam']:<12} {status_color}{r['status']:<10}{RESET} {elapsed_str:>8}")

    print(f"""
  Total time   : {total_elapsed:.1f}s ({total_elapsed/60:.1f} min)
  Total events : {total_events}
  Combined file: {combined_output}
  API URL      : {args.api_url}
""")

    if not args.dry_run:
        ok("Done! Refresh your dashboard to see live data.")
        print(f"\n  {CYAN}Dashboard: https://your-dashboard.vercel.app{RESET}")
        print(f"  {CYAN}Metrics  : {args.api_url}/api/stores/STORE_BLR_BRIGADE/metrics{RESET}\n")

if __name__ == "__main__":
    main()