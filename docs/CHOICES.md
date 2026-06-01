# CHOICES.md — Engineering Decision Log

Three decisions that shaped the system. Each documents: options considered, what AI tools suggested, what I chose, and why.

---

## Decision 1: Detection Model — YOLOv8m + ByteTrack

### Problem
Choose a person detection model and tracker for 1080p/15fps retail CCTV footage. The footage includes partial occlusion, group entries, staff movement, and varying lighting. The output must be structured events, not just bounding boxes.

### Options Considered

| Option | Accuracy | Speed (CPU) | Edge Case Handling | Setup Complexity |
|--------|----------|-------------|-------------------|------------------|
| YOLOv8n + DeepSORT | Medium | Fast | Weak partial occlusion | Medium |
| **YOLOv8m + ByteTrack** | **Good** | **Medium** | **Good** | **Low** |
| YOLOv8x + StrongSORT | Excellent | Slow | Excellent | High |
| RT-DETR + ByteTrack | Good | Slow | Good | High |
| MediaPipe Pose | Medium | Very fast | Poor (silhouettes only) | Very Low |

**What AI suggested:** I asked Claude to compare YOLOv8 variants for retail CCTV use cases. It recommended YOLOv8m as the "practical starting point" nano is too lossy for partial occlusion and crowded billing areas, while large/x variants are overkill without GPU. For tracking, it recommended ByteTrack over DeepSORT because ByteTrack recovers better from occlusion (it keeps "lost" tracks alive and matches them against low-confidence detections in the next pass, which is exactly what happens when a customer briefly passes behind a display).

I also asked GPT-4o to compare RT-DETR vs YOLOv8 for this use case. GPT-4o leaned toward RT-DETR for accuracy but acknowledged the installation complexity in a containerised environment. I weighted deployment simplicity higher than marginal accuracy gains.

**What I chose:** YOLOv8m + custom ByteTrack-style tracker

**Why:** The accuracy/speed/setup tradeoff of YOLOv8m is optimal for this challenge. The custom tracker (rather than the upstream ByteTrack library) avoids a CUDA dependency chain while preserving the two-pass matching logic that handles partial occlusion. I also implemented a lightweight HOG-based embedding for Re-ID rather than full OSNet, which avoids PyTorch version compatibility issues in Docker.

**Where I disagreed with AI:** Claude initially suggested using the upstream `boxmot` library (which includes StrongSORT and ByteTrack as plug-in trackers). I evaluated this but rejected it `boxmot` requires CUDA for the Re-ID models and has frequent breaking changes between versions. A self-contained implementation is more robust for a containerised submission.

**VLM evaluation (zone classification):**
I evaluated using Claude Vision for zone classification — submitting a frame crop and asking "which zone is this person in: SKINCARE, BILLING, ENTRY?". Results were surprisingly good for static layouts (~85% accuracy on test frames). However, at 5 API calls per second (5fps effective × 1 person per frame average), this would cost ~$2.40/minute of video at Claude API prices and introduce 300-800ms latency per classification. I chose polygon-based zone assignment (point-in-polygon test against `store_layout.json` coordinates) instead. This is O(1) per frame and perfectly accurate for fixed camera positions. The VLM approach would be worth revisiting for dynamic layouts or cameras that pan.

---

## Decision 2: Event Schema Design

### Problem
Design a schema that supports all required analytics (conversion funnel, dwell, queue depth, anomalies) while remaining compact enough for bulk ingestion and easy to evolve.

### Options Considered

**Option A: Flat schema (all fields top-level)**
```json
{ "event_id": "...", "queue_depth": 4, "sku_zone": "MOISTURISER", "session_seq": 3 }
```
Pros: simplest MongoDB queries. Cons: many null fields for most event types; schema pollution.

**Option B: Nested metadata object (chosen)**
```json
{ "event_id": "...", "metadata": { "queue_depth": 4, "sku_zone": "MOISTURISER", "session_seq": 3 } }
```
Pros: clean top-level schema; metadata is extensible without breaking changes. Cons: slightly more verbose aggregation queries (`$metadata.queue_depth` vs `$queue_depth`).

**Option C: Event type-specific schemas (polymorphic)**
Separate Mongoose schemas for ENTRY, ZONE_DWELL, BILLING_QUEUE_JOIN etc.
Pros: tight validation per type. Cons: complex aggregation across types; harder to build a single ingest endpoint.

**What AI suggested:** I asked Claude: "For a time-series event store in MongoDB that needs to support aggregation across event types, should I use a flat schema, nested metadata, or polymorphic documents?"

Claude recommended the nested metadata approach (Option B) specifically because MongoDB's `$group` aggregation handles nested fields well and the schema can be extended (new metadata fields) without a migration. It also pointed out that a polymorphic approach would complicate the ingest endpoint — validating 8 different schemas in a single POST would require a discriminator union type in Joi/Zod.

I agreed with Option B. I also adopted Claude's suggestion of always including `zone_id: null` for ENTRY/EXIT events rather than omitting the field — this makes Joi validation deterministic and avoids `undefined` vs `null` confusion in Node.js.

**One thing I changed:** Claude's initial schema suggestion included `device_id` (camera hardware identifier) separate from `camera_id`. I collapsed these into a single `camera_id` field since the problem statement only uses `camera_id` and adding a second identifier would complicate deduplication logic without business value for this submission.

**Schema evolution decision:** `session_seq` was made mandatory (not optional) after Claude argued that out-of-order event delivery (network retry, buffered batch) is a real production scenario, and `session_seq` is the only field that allows correct session reconstruction. This was a good call I wouldn't have made without the prompt.

---

## Decision 3: MongoDB over PostgreSQL for Event Storage

### Problem
Choose a persistence layer for the event stream. Requirements: idempotent bulk writes, fast aggregation by `(store_id, timestamp)`, sub-100ms queries for real-time metrics, easy Docker deployment.

### Options Considered

| Database | Bulk Upsert | Aggregation | Time-Series | Docker | Scale Path |
|----------|-------------|-------------|-------------|--------|------------|
| **MongoDB** | `bulkWrite` native | `$group` pipeline | TTL index | Official image | Sharding by store_id |
| PostgreSQL | `INSERT ON CONFLICT` | SQL window functions | TimescaleDB extension | Straightforward | Read replicas |
| Redis + PostgreSQL | LPUSH + async flush | SQL | N/A | Two services | Redis Cluster |
| InfluxDB | Native time-series | Flux queries | Native | Available | InfluxDB Cloud |

**What AI suggested:** I consulted Claude on this choice. It gave a balanced answer: "PostgreSQL is the safer production choice — ACID compliance, mature tooling, better consistency guarantees for financial data. MongoDB is more flexible for this schema and the aggregation pipeline maps more naturally to the analytics queries."

I also asked: "Which one has better support for `distinct()` counts at scale?" Claude correctly identified that both struggle with exact distinct counts at very high cardinalities and suggested HyperLogLog for production. For this submission's scale, exact counts are fine.

**What I chose:** MongoDB

**Why I chose MongoDB over Claude's preference for PostgreSQL:**

1. **Aggregation pipeline fit:** The analytics queries are essentially `GROUP BY store_id + event_type + date` with `DISTINCT visitor_id` — MongoDB's `$group` + `$addToSet` pipeline expresses this more naturally than SQL window functions, and it's easier to read and audit during a scoring session.

2. **Bulk upsert ergonomics:** `bulkWrite` with `$setOnInsert` is a single operation that handles idempotency atomically. PostgreSQL's `INSERT INTO ... ON CONFLICT DO NOTHING` is equivalent but the MongoDB version is easier to batch at variable sizes.

3. **Schema flexibility during development:** With 8 event types and a `metadata` object, MongoDB's document model allows adding new metadata fields without ALTER TABLE migrations. During a time-constrained challenge, this matters.

4. **Atlas free tier:** MongoDB Atlas has a generous free tier that makes cloud deployment (Render pointing at Atlas) trivial. This is directly relevant to the "deploy somewhere publicly accessible" goal.

**Where I disagree with the AI's PostgreSQL preference:** For a production system handling real financial conversion data, I would choose PostgreSQL + TimescaleDB. The ACID guarantees matter when a bug in the pipeline could report incorrect conversion rates to the business. For this challenge, MongoDB's flexibility outweighs the consistency trade-off.

**One thing AI got right:** Claude specifically recommended compound indexes `(store_id, timestamp)` and `(store_id, event_type, timestamp)` to avoid collection scans on the aggregation queries. I initially only had `(store_id, timestamp)` — adding the event_type index reduced query time on the `/metrics` endpoint significantly during local testing.
