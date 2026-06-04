# Store Intelligence System — Purplle Round 2

> End-to-end CCTV analytics pipeline: raw video → real-time store metrics API + live dashboard.

---

## Quick Start (5 Commands)

```bash
# 1. Clone and enter the project
git clone <your-repo-url> store-intelligence && cd store-intelligence

# 2. Copy environment config
cp .env.example .env

# 3. Start the full stack (MongoDB + API + Dashboard)
docker compose up --build -d

# 4. Verify the API is healthy
curl http://localhost:4000/api/health

# 5. Open the live dashboard
open http://localhost:3000
```

API live at `https://store-intelligence-vikas.vercel.app/` · Dashboard at `https://store-intelligence-api-jcib.onrender.com/`

---

## Running the Detection Pipeline

### Prerequisites

```bash
cd pipeline
pip install -r requirements.txt
# YOLOv8m model (~50MB) downloads automatically on first run
```

### Videos Placed in `data/videos/`

```
data/videos/
├── CAM 1.mp4    ← Entry/Exit camera
├── CAM 2.mp4    ← Floor camera (FOH center, Fragrance, Nail)
├── CAM 3.mp4    ← Floor camera (Skin wall, Makeup unit)
├── CAM 4.mp4    ← Billing / Cash Counter camera
└── CAM 5.mp4    ← Floor camera (Wall brands)
```

### Process ALL clips (one command)

```bash
chmod +x pipeline/run.sh
./pipeline/run.sh --api-url http://localhost:4000
```

This will:
1. Process each CAM 1–5 video with YOLOv8m + ByteTrack
2. Write per-camera events to `data/output/`
3. Ingest all events into the running API
4. Ingest POS transactions from `data/pos_transactions.csv`
5. Print a summary

### Process a single camera

```bash
python pipeline/detect.py \
  --video "data/videos/CAM 1.mp4" \
  --store STORE_BLR_BRIGADE \
  --camera CAM_1 \
  --layout data/store_layout.json \
  --output data/output/cam1_events.jsonl \
  --api-url http://localhost:4000 \
  --start-time 2026-04-10T12:00:00Z
```

### Simulated real-time (watch dashboard update live)

```bash
python pipeline/detect.py \
  --video "data/videos/CAM 1.mp4" \
  --store STORE_BLR_BRIGADE \
  --camera CAM_1 \
  --output data/output/cam1_realtime.jsonl \
  --api-url http://localhost:4000 \
  --start-time 2026-04-10T12:00:00Z \
  --realtime
```

Open `http://localhost:3000` → watch the **Live Event Feed** update in real time.

### Camera → Zone mapping (Brigade Road store)

| Camera | Type | Zones Covered |
|--------|------|--------------|
| CAM_1 | Entry/Exit | ENTRY_ZONE |
| CAM_2 | Floor | FOH_CENTER, FRAGRANCE, NAIL_UNIT |
| CAM_3 | Floor | SKIN (EB Korean, Minimalist, etc.), MAKEUP_UNIT |
| CAM_4 | Billing | CASH_COUNTER |
| CAM_5 | Floor | WALL_BRANDS (Faces Canada, Swiss Beauty, Renee, etc.) |

### Replay pre-processed events

```bash
python pipeline/ingest_events.py \
  --events data/output/all_events.jsonl \
  --api-url http://localhost:4000 \
  --batch-size 200
```

### Ingest POS transactions separately

```bash
python pipeline/ingest_pos.py \
  --csv data/pos_transactions.csv \
  --api-url http://localhost:4000
```

---

## 📌Mandatory Deliverables

All required submission artifacts are included in this repository:
* **Event Log:** The final consolidated JSONL output is located at `final_events.jsonl`.
* **Design Decisions:** `docs/DESIGN.md` (Includes the required AI-Assisted Decisions section).
* **Architecture Choices:** `docs/CHOICES.md` (Covers model selection, schema, and API architecture).

## API Reference

Base URL: `http://localhost:4000/api`

Swagger UI: `http://localhost:4000/api/docs`  
OpenAPI JSON: `http://localhost:4000/api/openapi.json`  
Deployed Swagger UI: `https://store-intelligence-api-jcib.onrender.com/api/docs`  
Deployed Dashboard: `https://store-intelligence-vikas.vercel.app/`

### `POST /events/ingest`
Idempotent batch event ingestion (up to 500 events per call).

```bash
curl -X POST http://localhost:4000/api/events/ingest \
  -H "Content-Type: application/json" \
  -d '{"events": [...]}'
```

### `GET /stores/STORE_BLR_BRIGADE/metrics`
Real-time KPIs: unique visitors, conversion rate, avg dwell, queue depth, abandonment rate.

```bash
curl http://localhost:4000/api/stores/STORE_BLR_BRIGADE/metrics
curl http://localhost:4000/api/stores/STORE_BLR_BRIGADE/metrics?window_hours=1
```

### `GET /stores/STORE_BLR_BRIGADE/funnel`
4-stage conversion funnel: Entry → Zone Visit → Billing Queue → Purchase.

```bash
curl http://localhost:4000/api/stores/STORE_BLR_BRIGADE/funnel
```

### `GET /stores/STORE_BLR_BRIGADE/heatmap`
Zone intensity grid (normalised 0–100), with `data_confidence` flag.

```bash
curl http://localhost:4000/api/stores/STORE_BLR_BRIGADE/heatmap
```

### `GET /stores/STORE_BLR_BRIGADE/anomalies`
Active anomalies: BILLING_QUEUE_SPIKE, CONVERSION_DROP, DEAD_ZONE, HIGH_QUEUE_ABANDONMENT, STALE_FEED.

```bash
curl http://localhost:4000/api/stores/STORE_BLR_BRIGADE/anomalies
```

### `GET /health`
Service health, per-store lag, STALE_FEED warnings.

```bash
curl http://localhost:4000/api/health
```

---

## Running Tests

```bash
cd app && npm install
npm test
npm test -- --coverage   # with coverage report
```

Tests use `mongodb-memory-server` — no external DB required.

---

## Project Structure

```
store-intelligence/
├── pipeline/
│   ├── detect.py           # YOLOv8m + ByteTrack + zone events
│   ├── tracker.py          # Kalman filter tracker + Re-ID gallery
│   ├── emit.py             # Event schema + buffer + HTTP emission
│   ├── ingest_events.py    # Batch replay from JSONL file
│   ├── ingest_pos.py       # Load POS CSV into API
│   ├── run.sh              # One-command: process all CAM 1-5 videos
│   └── requirements.txt
├── app/
│   ├── server.js           # Express + WebSocket server
│   ├── swagger.js           # Swagger for Api Documentation
│   ├── db.js               # MongoDB + Winston logger
│   ├── models/index.js     # Mongoose schemas
│   ├── middleware/index.js # Validation, auth, request logging
│   ├── routes/index.js     # All 6 API endpoints
│   └── services/
│       ├── ingest.js       # Idempotent bulkWrite
│       ├── metrics.js      # POS 5-min window correlation
│       ├── funnel.js       # Session-based funnel
│       ├── heatmap.js      # Zone intensity 0-100
│       ├── anomalies.js    # 4 anomaly types + STALE_FEED
│       └── health.js
├── dashboard/
│   └── src/                # React + Tailwind live dashboard
├── tests/
│   ├── test_ingest.test.js
│   ├── test_metrics.test.js
│   ├── test_anomalies.test.js
│   └── test_pipeline.py    # pytest pipeline unit tests
├── data/
│   ├── store_layout.json   # Brigade Road store zones + camera mapping
│   ├── pos_transactions.csv # Real April 10, 2026 transactions (24 orders)
│   └── sample_events.jsonl
├── docs/
│   ├── DESIGN.md
│   └── CHOICES.md
├── assertions.py           # 10 API assertions
├── docker-compose.yml
├── final_events.jsonl
└── README.md
```

---

## Deployment

### Render (API) + Vercel (Dashboard) + MongoDB Atlas

**Database: MongoDB Atlas**

**Backend Deployed on: Render**`

**Frontend: Vercel (Dashboard)**

### Local Docker

```bash
docker compose up --build -d    # start all services
docker compose logs -f api      # watch logs
docker compose down -v          # reset everything
```

---

## Live Dashboard

URL: **https://store-intelligence-vikas.vercel.app/**

- Live KPI cards (visitors, conversion rate, revenue, queue depth, avg dwell, abandon rate)
- 4-stage animated conversion funnel
- Zone heatmap with colour-coded intensity
- Active anomaly feed with severity + suggested actions
- Real-time WebSocket event stream (updates on every ingest)

---

## Edge Cases Handled

| Edge Case | Handling |
|-----------|----------|
| Group entry | YOLOv8 individual bounding boxes → 3 people = 3 ENTRY events |
| Staff movement | Trajectory heuristic: >5 min session OR >70% frame width movement |
| Re-entry | Re-ID gallery: same appearance embedding → same `visitor_id` → `REENTRY` |
| Partial occlusion | ByteTrack 2-pass: lost tracks matched against low-conf detections |
| Billing queue | `BillingQueueTracker` class: per-frame join/abandon delta |
| Empty store | All endpoints return `0` not `null` — never crashes |
| Camera overlap (CAM_1 + CAM_3) | Re-ID deduplicates same person across cameras |
| Zero purchases | `conversion_rate = 0.0` not `NaN` |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Detection | Python 3.11 · YOLOv8m (Ultralytics) |
| Tracking | Custom ByteTrack + Kalman filter |
| Re-ID | HOG histogram embedding + cosine distance |
| API | Node.js 20 · Express 4 · WebSocket (ws) |
| Database | MongoDB 7 · Mongoose 8 |
| Validation | Joi |
| Logging | Winston (structured JSON) |
| Dashboard | React 18 · Vite · Tailwind CSS |
| Container | Docker · Docker Compose · Nginx |
| API Documentation | Swagger |
| Tests | Jest · Supertest · mongodb-memory-server · pytest |
