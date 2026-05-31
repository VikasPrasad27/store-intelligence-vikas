/**
 * test_metrics.test.js — Tests for GET /stores/:id/metrics and /funnel
 *
 * # PROMPT:
 * "Write Jest + supertest tests for GET /stores/:id/metrics and
 *  GET /stores/:id/funnel. Cover: empty store returns valid JSON not null,
 *  staff excluded from counts, re-entry not double-counting unique visitors,
 *  zero purchases returns conversion_rate=0 not NaN, funnel stages always
 *  non-negative, window_hours query param, store not found returns empty
 *  metrics gracefully (not 404 or crash). Use a seeded MongoDB in-memory DB."
 *
 * # CHANGES MADE:
 * - Added staff exclusion assertion checking unique_visitors doesn't count staff
 * - Fixed re-entry deduplication test to seed both ENTRY and REENTRY events
 * - Added assertion that funnel.funnel array always has exactly 4 stages
 * - Changed 'store not found' expectation from 404 to 200 with zero values
 *   (the API returns empty metrics for unknown stores, not an error)
 */

const request = require('supertest')
const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

let app

function makeEvent(overrides = {}) {
  return {
    event_id:   uuidv4(),
    store_id:   'STORE_TEST_001',
    camera_id:  'CAM_ENTRY_01',
    visitor_id: `VIS_${Math.random().toString(36).slice(2, 8)}`,
    event_type: 'ENTRY',
    timestamp:  new Date().toISOString(),
    zone_id:    null,
    dwell_ms:   0,
    is_staff:   false,
    confidence: 0.9,
    metadata:   { queue_depth: null, sku_zone: null, session_seq: 1 },
    ...overrides,
  }
}

async function seedEvents(events) {
  const col = mongoose.connection.collection('events')
  const docs = events.map(e => ({
    ...e,
    timestamp: new Date(e.timestamp),
    createdAt: new Date(),
    updatedAt: new Date(),
  }))
  await col.insertMany(docs, { ordered: false }).catch(() => {})
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  process.env.PORT = '0'
  try {
    const { MongoMemoryServer } = require('mongodb-memory-server')
    const mongod = await MongoMemoryServer.create()
    process.env.MONGODB_URI = mongod.getUri()
    global.__mongod__ = mongod
  } catch {
    process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://localhost:27017/test_metrics'
  }
  const mod = require('../server')
  app = mod.app
  await new Promise(r => setTimeout(r, 500))
})

afterAll(async () => {
  await mongoose.connection.dropDatabase().catch(() => {})
  await mongoose.connection.close()
  if (global.__mongod__) await global.__mongod__.stop()
})

afterEach(async () => {
  await mongoose.connection.collection('events').deleteMany({}).catch(() => {})
  await mongoose.connection.collection('pos_transactions').deleteMany({}).catch(() => {})
})

// ── Metrics tests ─────────────────────────────────────────────────────────────

describe('GET /stores/:id/metrics', () => {

  test('empty store — returns valid JSON with zeros, not null or error', async () => {
    const res = await request(app)
      .get('/api/stores/STORE_EMPTY_999/metrics')
      .expect(200)

    expect(res.body.success).toBe(true)
    const d = res.body.data
    expect(d).not.toBeNull()
    expect(d.unique_visitors).toBe(0)
    expect(d.conversion_rate).toBe(0)
    expect(typeof d.abandonment_rate).toBe('number')
    expect(isNaN(d.conversion_rate)).toBe(false)
  })

  test('zero purchases — conversion_rate is 0, not NaN or null', async () => {
    await seedEvents([
      makeEvent({ event_type: 'ENTRY' }),
      makeEvent({ event_type: 'ENTRY' }),
    ])

    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/metrics')
      .expect(200)

    expect(res.body.data.conversion_rate).toBe(0)
    expect(isNaN(res.body.data.conversion_rate)).toBe(false)
  })

  test('staff excluded from unique_visitors count', async () => {
    await seedEvents([
      makeEvent({ event_type: 'ENTRY', is_staff: false }),
      makeEvent({ event_type: 'ENTRY', is_staff: false }),
      makeEvent({ event_type: 'ENTRY', is_staff: true }),   // should be excluded
      makeEvent({ event_type: 'ENTRY', is_staff: true }),   // should be excluded
    ])

    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/metrics')
      .expect(200)

    expect(res.body.data.unique_visitors).toBe(2)
  })

  test('re-entry does not double-count unique visitors', async () => {
    const visitorId = 'VIS_reentry01'
    await seedEvents([
      makeEvent({ visitor_id: visitorId, event_type: 'ENTRY' }),
      makeEvent({ visitor_id: visitorId, event_type: 'EXIT' }),
      makeEvent({ visitor_id: visitorId, event_type: 'REENTRY' }),
      // REENTRY uses same visitor_id — should not add +1 to unique_visitors
    ])

    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/metrics')
      .expect(200)

    // visitor_id appears once in ENTRY events → unique_visitors = 1
    expect(res.body.data.unique_visitors).toBe(1)
  })

  test('response includes store_id and computed_at', async () => {
    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/metrics')
      .expect(200)

    const d = res.body.data
    expect(d.store_id).toBe('STORE_TEST_001')
    expect(d.computed_at).toBeTruthy()
    expect(new Date(d.computed_at).toString()).not.toBe('Invalid Date')
  })

  test('window_hours query param is respected', async () => {
    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/metrics?window_hours=1')
      .expect(200)

    expect(res.body.data.window_hours).toBe(1)
  })

  test('reentry_count reflects REENTRY events in window', async () => {
    await seedEvents([
      makeEvent({ event_type: 'ENTRY' }),
      makeEvent({ event_type: 'REENTRY' }),
      makeEvent({ event_type: 'REENTRY' }),
    ])

    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/metrics')
      .expect(200)

    expect(res.body.data.reentry_count).toBe(2)
  })

  test('avg_dwell_by_zone is an object (not null)', async () => {
    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/metrics')
      .expect(200)

    expect(typeof res.body.data.avg_dwell_by_zone).toBe('object')
    expect(res.body.data.avg_dwell_by_zone).not.toBeNull()
  })
})

// ── Funnel tests ──────────────────────────────────────────────────────────────

describe('GET /stores/:id/funnel', () => {

  test('always returns exactly 4 funnel stages', async () => {
    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/funnel')
      .expect(200)

    expect(res.body.data.funnel).toHaveLength(4)
    const stages = res.body.data.funnel.map(s => s.stage)
    expect(stages).toEqual(['entry', 'zone_visit', 'billing_queue', 'purchase'])
  })

  test('funnel counts are non-negative', async () => {
    await seedEvents([
      makeEvent({ event_type: 'ENTRY' }),
      makeEvent({ event_type: 'ENTRY' }),
    ])

    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/funnel')
      .expect(200)

    res.body.data.funnel.forEach(stage => {
      expect(stage.count).toBeGreaterThanOrEqual(0)
      expect(stage.pct_of_total).toBeGreaterThanOrEqual(0)
    })
  })

  test('entry stage pct_of_total is always 100', async () => {
    await seedEvents([makeEvent({ event_type: 'ENTRY' })])

    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/funnel')
      .expect(200)

    const entryStage = res.body.data.funnel.find(s => s.stage === 'entry')
    expect(entryStage.pct_of_total).toBe(100)
  })

  test('empty store funnel — returns zeros with note', async () => {
    const res = await request(app)
      .get('/api/stores/STORE_EMPTY_FUNNEL/funnel')
      .expect(200)

    expect(res.body.data.funnel[0].count).toBe(0)
    expect(res.body.data.note).toBeTruthy()
  })

  test('staff excluded from funnel session count', async () => {
    await seedEvents([
      makeEvent({ event_type: 'ENTRY', is_staff: false }),
      makeEvent({ event_type: 'ENTRY', is_staff: true }),
    ])

    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/funnel')
      .expect(200)

    expect(res.body.data.session_count).toBe(1)
  })

  test('drop_off_pct keys all present', async () => {
    const res = await request(app)
      .get('/api/stores/STORE_TEST_001/funnel')
      .expect(200)

    const d = res.body.data.drop_off_pct
    expect(d).toHaveProperty('entry_to_zone')
    expect(d).toHaveProperty('zone_to_billing')
    expect(d).toHaveProperty('billing_to_purchase')
    expect(d).toHaveProperty('overall')
  })
})
