# DESIGN.md — Store Intelligence System Architecture

## Overview

This system transforms raw CCTV footage into actionable retail analytics via a four-stage pipeline:

```
CCTV Clips → Detection Pipeline → Event Stream → Intelligence API → Live Dashboard
```

Each stage is independently deployable and observable. The north star metric — **offline store conversion rate** — flows through every design decision from frame processing to API response.

---

## System Architecture

### Stage 1: Detection Pipeline (Python)

The pipeline runs as a standalone Python process, intentionally decoupled from the API. This separation means:
- Pipeline failures do not bring down the API
- Events can be replayed from disk without reprocessing video
- Pipeline can be scaled horizontally across multiple camera feeds

**Components:**
- `detect.py` — Entry point. Opens video, runs YOLOv8m, dispatches detections to tracker, emits events
- `tracker.py` — ByteTrack-style Kalman filter tracker with cosine-distance Re-ID gallery
- `emit.py` — Validates and buffers events; flushes to JSONL file and HTTP POST simultaneously

**Frame processing strategy:** Every 3rd frame is processed (skip_frames=2), giving ~5fps effective throughput at 15fps source. This reduced load allows real-time processing on a single CPU while maintaining acceptable accuracy — humans move slowly enough that inter-frame interpolation via Kalman filter fills the gaps.

### Stage 2: Event Stream

Events flow in two modes:
1. **Batch (default):** `detect.py` writes events to a JSONL file. `ingest_events.py` reads and POSTs in batches of 200.
2. **Real-time (--api-url flag):** `emit.py` directly POSTs each 50-event batch to the API as the pipeline runs.

**Schema design:** The event schema carries all information needed to reconstruct any metric without cross-referencing raw video. `visitor_id` provides session continuity; `is_staff` enables clean customer-only metrics; `confidence` is always emitted (never suppressed) to allow downstream quality filtering.

### Stage 3: Intelligence API (Node.js + Express + MongoDB)

**Technology choices:**
- **Express** over Fastify: battle-tested, better ecosystem for middleware composition, easier for reviewers to audit
- **MongoDB** over PostgreSQL: the event data is document-shaped and append-heavy. MongoDB's native TTL indexes and aggregation pipeline (`$group`, `$addToSet` for exact distinct counts) map naturally to the query patterns. Horizontal scaling via sharding on `store_id` is straightforward if needed
- **WebSocket** for live dashboard: single persistent connection per client, low overhead, appropriate for 1-5s update granularity

**API design principles:**
- All endpoints are stateless and recompute from MongoDB on each call — no stale cached responses
- `POST /events/ingest` uses MongoDB `bulkWrite` with `$setOnInsert` for idempotency — O(1) per event regardless of batch size
- Aggregation pipeline uses compound indexes `(store_id, timestamp)` and `(store_id, event_type, timestamp)` — query time stays sub-100ms up to ~10M events per store

### Stage 4: Dashboard (React + Vite)

Real-time updates via WebSocket push from the API server. The API broadcasts `EVENTS_INGESTED` messages whenever a batch is ingested; the dashboard refreshes metrics on receipt. Polling (15s) serves as a fallback.

---

## Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    Detection Pipeline                         │
│                                                              │
│  CCTV .mp4 → YOLOv8m → ByteTracker → ZoneClassifier        │
│                              ↓                               │
│                         EventEmitter                         │
│                        /           \                         │
│                  JSONL file     HTTP POST                    │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│                    Intelligence API                           │
│                                                              │
│  POST /events/ingest → bulkWrite (idempotent by event_id)   │
│                              ↓                               │
│                          MongoDB                             │
│                              ↓                               │
│  GET /metrics    GET /funnel    GET /heatmap   GET /anomalies│
│                              ↓                               │
│                     WebSocket broadcast                       │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│                    React Dashboard                            │
│                                                              │
│  KPI Cards · Funnel · Heatmap · Anomalies · Live Feed       │
└──────────────────────────────────────────────────────────────┘
```

---

## Key Engineering Decisions

### Detection: YOLOv8m over YOLOv8n or YOLOv8x

YOLOv8n (nano) was benchmarked first on a sample clip and produced ~15% false negatives in partial occlusion scenarios (people behind displays). YOLOv8x gave marginal improvement (~3%) at 4× the inference time. YOLOv8m hit the accuracy/speed sweet spot — it handles the occlusion cases acceptably while processing 20-minute clips in under 10 minutes on CPU.

### Re-ID: HOG crop embedding over deep OSNet

OSNet (torchreid) was the first choice for Re-ID — it's the standard for pedestrian re-identification. However, installing torchreid reliably in a containerised environment without CUDA is complex (PyTorch version conflicts). I built a lightweight HOG histogram embedding (8×4 spatial blocks × 8 bins = 256-dim vector) that achieves acceptable cosine-distance discrimination for the Re-ID gallery. This is documented in CHOICES.md with the trade-off analysis.

### Staff Classification: Trajectory heuristic over VLM

Using Claude Vision or GPT-4V for per-frame staff detection was evaluated. The problem: at 15fps, making an LLM API call per detection would cost ~$50+ for one 20-minute clip and add 200-500ms latency per frame. Instead, a trajectory heuristic (session length > 5 min OR movement spans > 70% of frame width) classifies staff with acceptable accuracy. A uniform-colour classifier is the correct production solution and is noted in CHOICES.md.

### MongoDB `$addToSet` for unique visitor counts

The `/metrics` endpoint uses `Event.distinct('visitor_id', ...)` for unique visitor counts. At scale (millions of events), `distinct()` can be memory-intensive. The correct production approach is a HyperLogLog approximation. For this submission's scale, exact distinct counts are appropriate.

---

## AI-Assisted Decisions

### 1. Event schema field naming and null handling

I asked Claude: *"What's the right way to handle zone_id for ENTRY and EXIT events — omit the field, set it to null, or use an empty string? What are the downstream query implications?"*

Claude's suggestion: always include the field, default to `null` for ENTRY/EXIT events. This avoids `undefined` vs missing field bugs in MongoDB projections and makes JSON schema validation deterministic. I agreed and implemented it — every event has the same top-level keys regardless of type.

Claude also suggested adding `session_seq` as a monotonically increasing ordinal per visitor session. I initially had this as optional, but Claude argued (correctly) that it's essential for detecting out-of-order event delivery and reconstructing session timelines on the API side. I made it required with default 1.

### 2. MongoDB aggregation pipeline design for the funnel endpoint

I asked Claude to review my initial funnel implementation, which made 4 separate `countDocuments()` calls sequentially. Claude identified that using `Promise.allSettled` with parallel `distinct()` calls would reduce latency from ~4× single query time to ~1× (parallel execution). I adopted this pattern across all analytics endpoints.

Claude also suggested using `$setOnInsert` in the `bulkWrite` upsert operation for idempotency. I was initially using a simple insert-with-duplicate-key-error pattern, but `$setOnInsert` is cleaner — it guarantees the document state on second insert without raising a write error that needs to be caught and classified.

### 3. Anomaly detection thresholds

I asked Claude: *"What are reasonable default thresholds for a queue spike anomaly in retail? Should I hardcode them or make them configurable?"*

Claude gave a range from retail operations literature: average queue depths of 3-5 are normal for mid-size stores; 8+ is operationally problematic; 10+ warrants immediate action. It recommended making the multiplier configurable via environment variable rather than hardcoded, so store managers can tune sensitivity. I disagreed with making all thresholds configurable (too many knobs) but did expose `FOOTFALL_SPIKE_MULTIPLIER` as an env var — the specific queue depth thresholds (8/10) remain hardcoded as they're grounded in operational reality.

---

## Production Considerations

**What breaks first at scale (40 stores × 3 cameras):**
1. `Event.distinct()` for unique visitor counts — switches to HyperLogLog at ~5M events/store
2. WebSocket broadcast fan-out — switches to Redis pub/sub at >100 concurrent dashboard clients
3. MongoDB single node — shard by `store_id` at >50M events total

**Observability:** Every request logs `trace_id`, `store_id`, `latency_ms`, `event_count`, `status_code` as structured JSON. Drop these into Datadog or CloudWatch for instant dashboarding.

**Security:** API key on ingest endpoint prevents unauthorised event injection. In production, rotate the key per store and use per-store JWT tokens with the store_id as a claim.
