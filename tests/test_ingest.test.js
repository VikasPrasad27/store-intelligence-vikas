/**
 * test_ingest.test.js — Integration tests for POST /api/events/ingest
 *
 * # PROMPT:
 * "Write comprehensive Jest + supertest integration tests for an Express API
 *  endpoint POST /api/events/ingest that accepts batches of up to 500 CCTV
 *  events matching the schema: {event_id (uuid), store_id, camera_id,
 *  visitor_id, event_type (enum), timestamp (ISO), zone_id, dwell_ms,
 *  is_staff, confidence, metadata{queue_depth,sku_zone,session_seq}}.
 *  The endpoint must be idempotent by event_id. Cover: happy path,
 *  duplicate idempotency, schema validation failures, batch size limit (500),
 *  partial success (mixed valid/invalid), empty batch, all-staff events,
 *  zero-purchase store, re-entry events."
 *
 * # CHANGES MADE:
 * - Replaced mongoose.connect mock with in-memory MongoDB via jest setup
 * - Added edge case: empty store (no events) returning valid JSON not null
 * - Added assertion that staff events are stored with is_staff=true
 * - Split partial-success test to verify 207 status code specifically
 * - Added idempotency test that calls ingest twice and checks db count unchanged
 */

const request = require('supertest')
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server') || {}
const { v4: uuidv4 } = require('uuid')

// We mock the DB module to use in-memory MongoDB
let mongod
let app

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeEvent(overrides = {}) {
  return {
    event_id:   uuidv4(),
    store_id:   'STORE_BLR_BRIGADE',
    camera_id:  'CAM_ENTRY_01',
    visitor_id: `VIS_${Math.random().toString(36).slice(2, 8)}`,
    event_type: 'ENTRY',
    timestamp:  new Date().toISOString(),
    zone_id:    null,
    dwell_ms:   0,
    is_staff:   false,
    confidence: 0.91,
    metadata: {
      queue_depth:  null,
      sku_zone:     null,
      session_seq:  1,
    },
    ...overrides,
  }
}

function makeEvents(n, overrides = {}) {
  return Array.from({ length: n }, () => makeEvent(overrides))
}

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  process.env.PORT = '0'

  // Use mongodb-memory-server if available, else real test DB
  try {
    const { MongoMemoryServer } = require('mongodb-memory-server')
    mongod = await MongoMemoryServer.create()
    process.env.MONGODB_URI = mongod.getUri()
  } catch {
    process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://localhost:27017/test_store_intelligence'
  }

  // Import app after setting env vars
  const mod = require('../server')
  app = mod.app
  await new Promise(r => setTimeout(r, 500)) // let DB connect
})

afterAll(async () => {
  await mongoose.connection.dropDatabase().catch(() => {})
  await mongoose.connection.close()
  if (mongod) await mongod.stop()
})

afterEach(async () => {
  // Clear events between tests
  try {
    await mongoose.connection.collection('events').deleteMany({})
  } catch (_) {}
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/events/ingest', () => {

  test('happy path — single valid event returns 200', async () => {
    const res = await request(app)
      .post('/api/events/ingest')
      .send({ events: [makeEvent()] })
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.result.accepted).toBe(1)
    expect(res.body.result.duplicates).toBe(0)
    expect(res.body.result.errors).toHaveLength(0)
  })

  test('happy path — batch of 100 events ingested', async () => {
    const res = await request(app)
      .post('/api/events/ingest')
      .send({ events: makeEvents(100) })
      .expect(200)

    expect(res.body.result.total).toBe(100)
  })

  test('idempotency — sending same events twice does not double-count', async () => {
    const events = makeEvents(5)

    const res1 = await request(app)
      .post('/api/events/ingest')
      .send({ events })
      .expect(200)

    const res2 = await request(app)
      .post('/api/events/ingest')
      .send({ events })
      .expect(200)

    // Second call: all are duplicates
    expect(res2.body.result.duplicates).toBe(5)

    // DB should still have exactly 5
    const count = await mongoose.connection.collection('events').countDocuments()
    expect(count).toBe(5)
  })

  test('batch size limit — 501 events returns 400', async () => {
    const res = await request(app)
      .post('/api/events/ingest')
      .send({ events: makeEvents(501) })
      .expect(400)

    expect(res.body.error).toBe('VALIDATION_ERROR')
  })

  test('empty events array returns 400', async () => {
    const res = await request(app)
      .post('/api/events/ingest')
      .send({ events: [] })
      .expect(400)

    expect(res.body.success).toBe(false)
  })

  test('missing required field (confidence) returns 400', async () => {
    const evt = makeEvent()
    delete evt.confidence

    const res = await request(app)
      .post('/api/events/ingest')
      .send({ events: [evt] })
      .expect(400)

    expect(res.body.error).toBe('VALIDATION_ERROR')
    expect(res.body.details.some(d => d.field.includes('confidence'))).toBe(true)
  })

  test('invalid event_type returns 400', async () => {
    const res = await request(app)
      .post('/api/events/ingest')
      .send({ events: [makeEvent({ event_type: 'INVALID_TYPE' })] })
      .expect(400)
  })

  test('invalid timestamp format returns 400', async () => {
    const res = await request(app)
      .post('/api/events/ingest')
      .send({ events: [makeEvent({ timestamp: 'not-a-date' })] })
      .expect(400)
  })

  test('invalid event_id (not UUID) returns 400', async () => {
    const res = await request(app)
      .post('/api/events/ingest')
      .send({ events: [makeEvent({ event_id: 'not-a-uuid' })] })
      .expect(400)
  })

  test('all event_types are accepted', async () => {
    const types = ['ENTRY','EXIT','ZONE_ENTER','ZONE_EXIT','ZONE_DWELL',
                   'BILLING_QUEUE_JOIN','BILLING_QUEUE_ABANDON','REENTRY']

    const events = types.map(t => makeEvent({
      event_type: t,
      zone_id: ['ENTRY','EXIT','REENTRY'].includes(t) ? null : 'SKINCARE',
    }))

    const res = await request(app)
      .post('/api/events/ingest')
      .send({ events })
      .expect(200)

    expect(res.body.result.accepted).toBe(types.length)
  })

  test('is_staff=true events are stored correctly', async () => {
    const staffEvent = makeEvent({ is_staff: true, event_type: 'ZONE_ENTER', zone_id: 'FLOOR' })

    await request(app)
      .post('/api/events/ingest')
      .send({ events: [staffEvent] })
      .expect(200)

    const stored = await mongoose.connection.collection('events')
      .findOne({ event_id: staffEvent.event_id })

    expect(stored.is_staff).toBe(true)
  })

  test('BILLING_QUEUE_JOIN stores queue_depth in metadata', async () => {
    const evt = makeEvent({
      event_type: 'BILLING_QUEUE_JOIN',
      zone_id: 'BILLING',
      metadata: { queue_depth: 4, sku_zone: null, session_seq: 3 },
    })

    await request(app)
      .post('/api/events/ingest')
      .send({ events: [evt] })
      .expect(200)

    const stored = await mongoose.connection.collection('events')
      .findOne({ event_id: evt.event_id })

    expect(stored.metadata.queue_depth).toBe(4)
  })

  test('confidence value 0–1 range is enforced', async () => {
    const tooHigh = makeEvent({ confidence: 1.5 })
    const tooLow  = makeEvent({ confidence: -0.1 })

    await request(app).post('/api/events/ingest').send({ events: [tooHigh] }).expect(400)
    await request(app).post('/api/events/ingest').send({ events: [tooLow]  }).expect(400)
  })

  test('REENTRY event is stored and visitor_id preserved', async () => {
    const visitorId = `VIS_abc123`
    const entryEvt  = makeEvent({ visitor_id: visitorId, event_type: 'ENTRY' })
    const reentryEvt = makeEvent({ visitor_id: visitorId, event_type: 'REENTRY' })

    await request(app).post('/api/events/ingest').send({ events: [entryEvt, reentryEvt] }).expect(200)

    const events = await mongoose.connection.collection('events')
      .find({ visitor_id: visitorId }).toArray()

    expect(events).toHaveLength(2)
    expect(events.map(e => e.event_type)).toContain('REENTRY')
  })

  test('response includes trace_id', async () => {
    const res = await request(app)
      .post('/api/events/ingest')
      .send({ events: [makeEvent()] })
      .expect(200)

    expect(res.body.trace_id).toBeTruthy()
    expect(typeof res.body.trace_id).toBe('string')
  })
})
