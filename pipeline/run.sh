#!/usr/bin/env bash
# run.sh — Process all CCTV clips for Brigade Road Bangalore store
# Videos: CAM 1.mp4, CAM 2.mp4, CAM 3.mp4, CAM 4.mp4, CAM 5.mp4
# Usage: ./pipeline/run.sh [--api-url http://localhost:4000] [--realtime]
set -euo pipefail

VIDEOS_DIR="${VIDEOS_DIR:-data/videos}"
OUTPUT_DIR="${OUTPUT_DIR:-data/output}"
LAYOUT="${LAYOUT:-data/store_layout.json}"
API_URL="${API_URL:-http://localhost:4000}"
SKIP_FRAMES="${SKIP_FRAMES:-2}"
CONF="${CONF:-0.35}"
REALTIME_FLAG=""
STORE_ID="STORE_BLR_BRIGADE"

for arg in "$@"; do
  case $arg in
    --realtime) REALTIME_FLAG="--realtime" ;;
    --api-url=*) API_URL="${arg#*=}" ;;
    --api-url) shift; API_URL="$1" ;;
    --skip=*) SKIP_FRAMES="${arg#*=}" ;;
  esac
done

mkdir -p "$OUTPUT_DIR"
COMBINED_OUTPUT="$OUTPUT_DIR/all_events.jsonl"
> "$COMBINED_OUTPUT"

echo "============================================"
echo "  Purplle Brigade Road — CCTV Pipeline"
echo "  Store: $STORE_ID"
echo "  Date:  2026-04-10"
echo "============================================"
echo "Videos dir : $VIDEOS_DIR"
echo "API URL    : $API_URL"
echo ""

# Install Python deps if needed
cd pipeline
if ! python -c "import ultralytics" 2>/dev/null; then
  echo "[INFO] Installing Python dependencies..."
  python -m pip install -r requirements.txt -q
fi
cd ..

# Camera mapping: CAM 1=entry, CAM 2=floor(FOH), CAM 3=floor(skin/makeup),
#                 CAM 4=billing, CAM 5=floor(wall brands)
declare -A CAM_IDS=(
  ["CAM 1"]="CAM_1"
  ["CAM 2"]="CAM_2"
  ["CAM 3"]="CAM_3"
  ["CAM 4"]="CAM_4"
  ["CAM 5"]="CAM_5"
)

# Start times based on the actual store data (April 10, 2026 — store opens 11am)
declare -A CAM_START_TIMES=(
  ["CAM_1"]="2026-04-10T12:00:00Z"
  ["CAM_2"]="2026-04-10T12:00:00Z"
  ["CAM_3"]="2026-04-10T12:00:00Z"
  ["CAM_4"]="2026-04-10T12:00:00Z"
  ["CAM_5"]="2026-04-10T12:00:00Z"
)

PROCESSED=0; FAILED=0

for cam_name in "CAM 1" "CAM 2" "CAM 3" "CAM 4" "CAM 5"; do
  video_file="$VIDEOS_DIR/${cam_name}.mp4"
  [ -f "$video_file" ] || { echo "[SKIP] $video_file not found"; continue; }

  camera_id="${CAM_IDS[$cam_name]}"
  start_time="${CAM_START_TIMES[$camera_id]}"
  clip_output="$OUTPUT_DIR/${camera_id}_events.jsonl"

  echo ""
  echo "── Processing: $cam_name ──"
  echo "  Camera ID : $camera_id"
  echo "  Start time: $start_time"
  echo "  Output    : $clip_output"

  if python pipeline/detect.py \
      --video "$video_file" \
      --store "$STORE_ID" \
      --camera "$camera_id" \
      --layout "$LAYOUT" \
      --output "$clip_output" \
      --api-url "$API_URL" \
      --skip "$SKIP_FRAMES" \
      --conf "$CONF" \
      --start-time "$start_time" \
      $REALTIME_FLAG; then
    cat "$clip_output" >> "$COMBINED_OUTPUT"
    PROCESSED=$((PROCESSED + 1))
    echo "[OK] $cam_name done"
  else
    FAILED=$((FAILED + 1))
    echo "[FAIL] $cam_name failed"
  fi
done

echo ""
echo "============================================"
echo "Pipeline complete: $PROCESSED ok, $FAILED failed"
echo "Combined output : $COMBINED_OUTPUT"
echo "============================================"

# Ingest into API if not already streamed
if [ -f "$COMBINED_OUTPUT" ] && [ "$API_URL" != "" ]; then
  echo ""
  echo "Ingesting combined events into API..."
  python pipeline/ingest_events.py \
    --events "$COMBINED_OUTPUT" \
    --api-url "$API_URL" \
    --batch-size 200 || echo "[WARN] Batch ingest failed — is the API running?"
fi

# Also ingest POS transactions
echo ""
echo "Ingesting POS transactions..."
python pipeline/ingest_pos.py \
  --csv data/pos_transactions.csv \
  --api-url "$API_URL" || echo "[WARN] POS ingest failed"

echo "Done. Open http://localhost:3000 for the live dashboard."
