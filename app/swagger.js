const swaggerUi = require('swagger-ui-express');

const eventSchema = {
  type: 'object',
  required: ['event_id', 'store_id', 'camera_id', 'visitor_id', 'event_type', 'timestamp', 'confidence'],
  properties: {
    event_id: { type: 'string', format: 'uuid' },
    store_id: { type: 'string', example: 'STORE_BLR_BRIGADE' },
    camera_id: { type: 'string', example: 'CAM_1' },
    visitor_id: { type: 'string', example: 'VIS_001' },
    event_type: {
      type: 'string',
      enum: ['ENTRY', 'EXIT', 'ZONE_ENTER', 'ZONE_EXIT', 'ZONE_DWELL', 'BILLING_QUEUE_JOIN', 'BILLING_QUEUE_ABANDON', 'REENTRY'],
    },
    timestamp: { type: 'string', format: 'date-time', example: '2026-04-10T12:00:00Z' },
    zone_id: { type: 'string', nullable: true, example: 'ENTRY_ZONE' },
    dwell_ms: { type: 'integer', minimum: 0, example: 0 },
    is_staff: { type: 'boolean', example: false },
    confidence: { type: 'number', minimum: 0, maximum: 1, example: 0.85 },
    metadata: {
      type: 'object',
      properties: {
        queue_depth: { type: 'integer', nullable: true, example: null },
        sku_zone: { type: 'string', nullable: true, example: null },
        session_seq: { type: 'integer', minimum: 1, example: 1 },
      },
    },
  },
};

const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Store Intelligence API',
    version: '1.0.0',
    description: 'Real-time CCTV analytics API for ingestion, metrics, funnel, heatmap, anomalies, stores, and health.',
  },
  servers: [
    { url: 'https://store-intelligence-api-jcib.onrender.com/api', description: 'Render API' },
    { url: 'http://localhost:4000/api', description: 'Local Docker API' },
    { url: '/api', description: 'Same-origin API' },
  ],
  tags: [
    { name: 'Ingestion' },
    { name: 'Stores' },
    { name: 'Health' },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Api-Key',
      },
    },
    schemas: {
      Event: eventSchema,
      POSTransaction: {
        type: 'object',
        required: ['transaction_id', 'store_id', 'timestamp', 'basket_value_inr'],
        properties: {
          transaction_id: { type: 'string', example: 'TXN_001' },
          store_id: { type: 'string', example: 'STORE_BLR_BRIGADE' },
          timestamp: { type: 'string', format: 'date-time', example: '2026-04-10T12:05:00Z' },
          basket_value_inr: { type: 'number', example: 1499.0 },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: { type: 'string', example: 'VALIDATION_ERROR' },
          message: { type: 'string' },
          trace_id: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/events/ingest': {
      post: {
        tags: ['Ingestion'],
        summary: 'Ingest CCTV analytics events',
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['events'],
                properties: {
                  events: { type: 'array', minItems: 1, maxItems: 500, items: { $ref: '#/components/schemas/Event' } },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Events ingested' },
          207: { description: 'Partial success' },
          400: { description: 'Validation error' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    '/pos/ingest': {
      post: {
        tags: ['Ingestion'],
        summary: 'Ingest POS transactions',
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['transactions'],
                properties: {
                  transactions: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/POSTransaction' } },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'POS transactions ingested' },
          400: { description: 'Invalid request' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    '/stores': {
      get: {
        tags: ['Stores'],
        summary: 'List stores with event counts',
        responses: { 200: { description: 'Store list' } },
      },
    },
    '/stores/{id}/metrics': {
      get: {
        tags: ['Stores'],
        summary: 'Get real-time KPIs for a store',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'STORE_BLR_BRIGADE' },
          { name: 'window_hours', in: 'query', schema: { type: 'integer', default: 24 } },
        ],
        responses: { 200: { description: 'Metrics response' } },
      },
    },
    '/stores/{id}/funnel': {
      get: {
        tags: ['Stores'],
        summary: 'Get conversion funnel for a store',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'STORE_BLR_BRIGADE' },
          { name: 'window_hours', in: 'query', schema: { type: 'integer', default: 24 } },
        ],
        responses: { 200: { description: 'Funnel response' } },
      },
    },
    '/stores/{id}/heatmap': {
      get: {
        tags: ['Stores'],
        summary: 'Get zone heatmap for a store',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'STORE_BLR_BRIGADE' },
          { name: 'window_hours', in: 'query', schema: { type: 'integer', default: 24 } },
        ],
        responses: { 200: { description: 'Heatmap response' } },
      },
    },
    '/stores/{id}/anomalies': {
      get: {
        tags: ['Stores'],
        summary: 'Get active anomalies for a store',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'STORE_BLR_BRIGADE' },
        ],
        responses: { 200: { description: 'Anomaly response' } },
      },
    },
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Get API and database health',
        responses: {
          200: { description: 'Health response' },
          503: { description: 'Service unavailable' },
        },
      },
    },
  },
};

function mountSwagger(app) {
  app.get('/api/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'Store Intelligence API Docs',
  }));
}

module.exports = { mountSwagger, openApiSpec };
