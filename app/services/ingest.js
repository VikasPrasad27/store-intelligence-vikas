const { Event, POSTransaction } = require('../models');
const { logger } = require('../db');

/**
 * Ingest a batch of validated events into MongoDB.
 * Idempotent by event_id — safe to call twice with same payload.
 *
 * Returns { accepted, duplicates, errors[] }
 */
async function ingestEvents(events) {
  const accepted = [];
  const duplicates = [];
  const errors = [];

  // Build bulk ops — use upsert so re-sending same event_id is a no-op
  const bulkOps = events.map(evt => ({
    updateOne: {
      filter: { event_id: evt.event_id },
      update: {
        $setOnInsert: {
          event_id: evt.event_id,
          store_id: evt.store_id,
          camera_id: evt.camera_id,
          visitor_id: evt.visitor_id,
          event_type: evt.event_type,
          timestamp: new Date(evt.timestamp),
          zone_id: evt.zone_id || null,
          dwell_ms: evt.dwell_ms || 0,
          is_staff: evt.is_staff || false,
          confidence: evt.confidence,
          metadata: {
            queue_depth: evt.metadata?.queue_depth ?? null,
            sku_zone: evt.metadata?.sku_zone ?? null,
            session_seq: evt.metadata?.session_seq ?? 1,
          },
        },
      },
      upsert: true,
    },
  }));

  try {
    const result = await Event.bulkWrite(bulkOps, { ordered: false });

    const insertedCount = result.upsertedCount || 0;
    const matchedCount = result.matchedCount || 0;

    // Classify each event
    const upsertedIds = new Set(
      Object.values(result.upsertedIds || {}).map(id => id?.toString())
    );

    events.forEach((evt, idx) => {
      const wasInserted = idx < insertedCount || upsertedIds.size > 0;
      // Simpler: any event that wasn't upserted = duplicate
    });

    // Log summary
    logger.info('Batch ingested', {
      total: events.length,
      inserted: insertedCount,
      duplicates: matchedCount,
      store_id: events[0]?.store_id,
    });

    return {
      accepted: insertedCount,
      duplicates: matchedCount,
      errors: [],
      total: events.length,
    };
  } catch (err) {
    // Handle partial failures from bulkWrite
    if (err.writeErrors) {
      err.writeErrors.forEach(we => {
        errors.push({
          index: we.index,
          event_id: events[we.index]?.event_id,
          message: we.errmsg,
        });
      });
      logger.warn('Partial ingest failure', {
        total: events.length,
        error_count: errors.length,
      });
      return {
        accepted: events.length - errors.length,
        duplicates: 0,
        errors,
        total: events.length,
      };
    }
    logger.error('Ingest bulk write failed', { error: err.message });
    throw err;
  }
}

/**
 * Ingest POS transactions.
 */
async function ingestPOS(transactions) {
  const ops = transactions.map(tx => ({
    updateOne: {
      filter: { transaction_id: tx.transaction_id },
      update: { $setOnInsert: tx },
      upsert: true,
    },
  }));
  await POSTransaction.bulkWrite(ops, { ordered: false });
}

module.exports = { ingestEvents, ingestPOS };
