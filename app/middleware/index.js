const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('../db');

// ── Event validation schema ───────────────────────────────────────────────────
const eventSchema = Joi.object({
  event_id: Joi.string().uuid({ version: 'uuidv4' }).required(),
  store_id: Joi.string().required(),
  camera_id: Joi.string().required(),
  visitor_id: Joi.string().required(),
  event_type: Joi.string()
    .valid(
      'ENTRY', 'EXIT', 'ZONE_ENTER', 'ZONE_EXIT',
      'ZONE_DWELL', 'BILLING_QUEUE_JOIN', 'BILLING_QUEUE_ABANDON', 'REENTRY'
    )
    .required(),
  timestamp: Joi.string().isoDate().required(),
  zone_id: Joi.string().allow(null, '').default(null),
  dwell_ms: Joi.number().min(0).default(0),
  is_staff: Joi.boolean().default(false),
  confidence: Joi.number().min(0).max(1).required(),
  metadata: Joi.object({
    queue_depth: Joi.number().integer().min(0).allow(null).default(null),
    sku_zone: Joi.string().allow(null, '').default(null),
    session_seq: Joi.number().integer().min(1).default(1),
  }).default({}),
});

const batchSchema = Joi.object({
  events: Joi.array().items(eventSchema).min(1).max(500).required(),
  store_id: Joi.string().optional(),
});

// ── Validation middleware ─────────────────────────────────────────────────────
function validateBatch(req, res, next) {
  const { error, value } = batchSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: false,
    convert: true,
  });

  if (error) {
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'Request body failed schema validation',
      details: error.details.map(d => ({
        field: d.path.join('.'),
        message: d.message,
      })),
    });
  }

  req.validatedBody = value;
  next();
}

// ── Request logger middleware (structured) ────────────────────────────────────
function requestLogger(req, res, next) {
  const traceId = uuidv4();
  req.traceId = traceId;
  const startTime = Date.now();

res.on('finish', () => {
  try {
    const latencyMs = Date.now() - startTime;

    logger.info('HTTP request', {
      trace_id: traceId,
      method: req.method,
      path: req.path,
      store_id: req.params?.id ?? req.body?.store_id ?? null,
      endpoint: `${req.method} ${req.route?.path ?? req.path}`,
      latency_ms: latencyMs,
      event_count: req.validatedBody?.events?.length ?? null,
      status_code: res.statusCode,
      ip: req.ip,
    });
  } catch (err) {
    logger.error('Request logging failed', {
      error: err.message,
    });
  }
});

  next();
}

// ── API key auth middleware ────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  const validKey = process.env.API_KEY;

  // Skip auth in test env
  if (process.env.NODE_ENV === 'test') return next();

  if (!validKey || key === validKey) return next();

  return res.status(401).json({
    success: false,
    error: 'UNAUTHORIZED',
    message: 'Valid X-Api-Key header required for ingest',
  });
}

// ── DB availability check ─────────────────────────────────────────────────────
function requireDB(req, res, next) {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      error: 'SERVICE_UNAVAILABLE',
      message: 'Database unavailable — please retry shortly',
      trace_id: req.traceId,
    });
  }
  next();
}

module.exports = { validateBatch, requestLogger, requireApiKey, requireDB };
