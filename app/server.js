require('dotenv').config();
require('express-async-errors');

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const { connectDB, logger } = require('./db');
const { requestLogger } = require('./middleware');
const routes = require('./routes');
const { mountSwagger } = require('./swagger');

const app = express();
const server = http.createServer(app);

// ── Security & Performance ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
    },
  },
}));
app.use(compression());
app.set('trust proxy', 1);

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://store-intelligence-vikas.vercel.app',
  ...(process.env.CORS_ORIGIN || '').split(','),
].map(origin => origin.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        return cb(null, true);
      }
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'Authorization'],
  })
);

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' },
});
app.use('/api', limiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Structured request logging ────────────────────────────────────────────────
app.use(requestLogger);

// ── Routes ────────────────────────────────────────────────────────────────────
mountSwagger(app);
app.use('/api', routes);

// Root redirect
app.get('/', (req, res) => {
  res.json({
    name: 'Store Intelligence API',
    version: '1.0.0',
    docs: '/api/docs',
    openapi: '/api/openapi.json',
    endpoints: [
      'POST /api/events/ingest',
      'POST /api/pos/ingest',
      'GET  /api/stores/:id/metrics',
      'GET  /api/stores/:id/funnel',
      'GET  /api/stores/:id/heatmap',
      'GET  /api/stores/:id/anomalies',
      'GET  /api/health',
      'GET  /api/stores',
    ],
  });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    trace_id: req.traceId,
    path: req.path,
  });

  // Never expose raw stack traces in production
  const statusCode = err.status || err.statusCode || 500;
  return res.status(statusCode).json({
    success: false,
    error: err.code || 'INTERNAL_SERVER_ERROR',
    message:
      process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message,
    trace_id: req.traceId,
  });
});

// ── WebSocket server (real-time dashboard feed) ───────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws, req) => {
  const clientId = uuidv4().slice(0, 8);
  clients.add(ws);
  logger.info('WebSocket client connected', { clientId, total: clients.size });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    client_id: clientId,
    timestamp: new Date().toISOString(),
    message: 'Store Intelligence real-time feed connected',
  }));

  ws.on('close', () => {
    clients.delete(ws);
    logger.info('WebSocket client disconnected', { clientId, remaining: clients.size });
  });

  ws.on('error', (err) => {
    logger.warn('WebSocket error', { clientId, error: err.message });
    clients.delete(ws);
  });

  // Ping/pong for keepalive
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
      }
    } catch (_) {}
  });
});

// Broadcast function — attached to app.locals for use in routes
function broadcast(payload) {
  const message = JSON.stringify(payload);
  clients.forEach(ws => {
    if (ws.readyState === 1) { // OPEN
      ws.send(message);
    }
  });
}

app.locals.broadcast = broadcast;

// ── Startup ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || 4000);

async function start() {
  try {
    await connectDB();
    server.listen(PORT, () => {
      logger.info(`Store Intelligence API started`, {
        port: PORT,
        env: process.env.NODE_ENV || 'development',
        ws: `ws://localhost:${PORT}/ws`,
      });
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  server.close(() => {
    require('mongoose').connection.close();
    process.exit(0);
  });
});

start();

module.exports = { app, server }; // exported for tests
