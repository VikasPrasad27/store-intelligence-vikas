const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { validateBatch, requireApiKey, requireDB } = require('../middleware');
const { ingestEvents, ingestPOS } = require('../services/ingest');
const { getStoreMetrics } = require('../services/metrics');
const { getStoreFunnel } = require('../services/funnel');
const { getStoreHeatmap } = require('../services/heatmap');
const { getStoreAnomalies } = require('../services/anomalies');
const { getHealth } = require('../services/health');
const { logger } = require('../db');

const router = express.Router();

// ── POST /events/ingest ───────────────────────────────────────────────────────
router.post(
  '/events/ingest',
  requireApiKey,
  requireDB,
  validateBatch,
  async (req, res) => {
    const { events } = req.validatedBody;

    try {
      const result = await ingestEvents(events);

      // Broadcast to WebSocket clients (real-time dashboard)
      if (req.app.locals.broadcast) {
        req.app.locals.broadcast({
          type: 'EVENTS_INGESTED',
          store_id: events[0]?.store_id,
          accepted: result.accepted,
          timestamp: new Date().toISOString(),
          sample_event_types: [...new Set(events.map(e => e.event_type))],
        });
      }

      const statusCode = result.errors.length > 0 ? 207 : 200;
      return res.status(statusCode).json({
        success: true,
        trace_id: req.traceId,
        result: {
          total: result.total,
          accepted: result.accepted,
          duplicates: result.duplicates,
          errors: result.errors,
        },
        message:
          result.errors.length > 0
            ? 'Partial success — some events failed validation'
            : `${result.accepted} events ingested successfully`,
      });
    } catch (err) {
      logger.error('Ingest failed', { error: err.message, trace_id: req.traceId });
      throw err;
    }
  }
);

// ── POST /pos/ingest ──────────────────────────────────────────────────────────
router.post('/pos/ingest', requireApiKey, requireDB, async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ success: false, error: 'transactions array required' });
  }
  await ingestPOS(transactions);
  return res.json({ success: true, count: transactions.length });
});

// ── GET /stores/:id/metrics ───────────────────────────────────────────────────
router.get('/stores/:id/metrics', requireDB, async (req, res) => {
  const { id } = req.params;
  const windowHours = parseInt(req.query.window_hours) || 24;

  const metrics = await getStoreMetrics(id, windowHours);

  return res.json({
    success: true,
    trace_id: req.traceId,
    data: metrics,
  });
});

// ── GET /stores/:id/funnel ────────────────────────────────────────────────────
router.get('/stores/:id/funnel', requireDB, async (req, res) => {
  const { id } = req.params;
  const windowHours = parseInt(req.query.window_hours) || 24;

  const funnel = await getStoreFunnel(id, windowHours);

  return res.json({
    success: true,
    trace_id: req.traceId,
    data: funnel,
  });
});

// ── GET /stores/:id/heatmap ───────────────────────────────────────────────────
router.get('/stores/:id/heatmap', requireDB, async (req, res) => {
  const { id } = req.params;
  const windowHours = parseInt(req.query.window_hours) || 24;

  const heatmap = await getStoreHeatmap(id, windowHours);

  return res.json({
    success: true,
    trace_id: req.traceId,
    data: heatmap,
  });
});

// ── GET /stores/:id/anomalies ─────────────────────────────────────────────────
router.get('/stores/:id/anomalies', requireDB, async (req, res) => {
  const { id } = req.params;

  const anomalies = await getStoreAnomalies(id);

  return res.json({
    success: true,
    trace_id: req.traceId,
    data: anomalies,
  });
});

// ── GET /health ───────────────────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  const health = await getHealth();
  const statusCode = health.status === 'OK' ? 200 : health.status === 'DEGRADED' ? 200 : 503;
  return res.status(statusCode).json(health);
});

// ── GET /stores (list all stores with event counts) ───────────────────────────
router.get('/stores', requireDB, async (req, res) => {
  const { Event } = require('../models');
  const stores = await Event.aggregate([
    { $group: { _id: '$store_id', event_count: { $sum: 1 }, last_event: { $max: '$timestamp' } } },
    { $sort: { _id: 1 } },
  ]);
  return res.json({ success: true, stores: stores.map(s => ({ store_id: s._id, event_count: s.event_count, last_event: s.last_event })) });
});

module.exports = router;
