const mongoose = require('mongoose');

// ── Event Schema ──────────────────────────────────────────────────────────────
// Mirrors the required output schema from the problem statement verbatim.
const eventSchema = new mongoose.Schema(
  {
    event_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Legacy compatibility for older Atlas indexes/deploys that used eventId.
    eventId: {
      type: String,
      index: true,
    },
    store_id: {
      type: String,
      required: true,
      index: true,
    },
    camera_id: {
      type: String,
      required: true,
    },
    visitor_id: {
      type: String,
      required: true,
      index: true,
    },
    event_type: {
      type: String,
      required: true,
      enum: [
        'ENTRY',
        'EXIT',
        'ZONE_ENTER',
        'ZONE_EXIT',
        'ZONE_DWELL',
        'BILLING_QUEUE_JOIN',
        'BILLING_QUEUE_ABANDON',
        'REENTRY',
      ],
      index: true,
    },
    timestamp: {
      type: Date,
      required: true,
      index: true,
    },
    zone_id: {
      type: String,
      default: null,
    },
    dwell_ms: {
      type: Number,
      default: 0,
      min: 0,
    },
    is_staff: {
      type: Boolean,
      default: false,
      index: true,
    },
    confidence: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
    },
    metadata: {
      queue_depth: { type: Number, default: null },
      sku_zone: { type: String, default: null },
      session_seq: { type: Number, default: 1 },
    },
  },
  {
    timestamps: true,  // adds createdAt / updatedAt
    collection: 'events',
  }
);

// Compound indexes for common query patterns
eventSchema.index({ store_id: 1, timestamp: -1 });
eventSchema.index({ store_id: 1, event_type: 1, timestamp: -1 });
eventSchema.index({ store_id: 1, visitor_id: 1, timestamp: 1 });
eventSchema.index({ store_id: 1, is_staff: 1, timestamp: -1 });
eventSchema.index({ visitor_id: 1, event_type: 1 });

const Event = mongoose.model('Event', eventSchema);

// ── POS Transaction Schema ────────────────────────────────────────────────────
const posSchema = new mongoose.Schema(
  {
    store_id: { type: String, required: true, index: true },
    transaction_id: { type: String, required: true, unique: true },
    timestamp: { type: Date, required: true, index: true },
    basket_value_inr: { type: Number, required: true, min: 0 },
  },
  { collection: 'pos_transactions' }
);

posSchema.index({ store_id: 1, timestamp: -1 });

const POSTransaction = mongoose.model('POSTransaction', posSchema);

// ── Store Config Schema ───────────────────────────────────────────────────────
const storeSchema = new mongoose.Schema(
  {
    store_id: { type: String, required: true, unique: true },
    name: String,
    city: String,
    open_hours: {
      open: { type: String, default: '09:00' },
      close: { type: String, default: '21:00' },
    },
    zones: [
      {
        zone_id: String,
        zone_name: String,
        camera_ids: [String],
        zone_type: {
          type: String,
          enum: ['entry_exit', 'floor', 'billing', 'storage', 'unknown'],
          default: 'floor',
        },
      },
    ],
    cameras: [
      {
        camera_id: String,
        type: {
          type: String,
          enum: ['entry', 'floor', 'billing'],
          default: 'floor',
        },
        zone_coverage: [String],
      },
    ],
  },
  { collection: 'stores' }
);

const Store = mongoose.model('Store', storeSchema);

module.exports = { Event, POSTransaction, Store };
