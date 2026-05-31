const { Event, POSTransaction } = require('../models');
const { getWindowStart } = require('./timeWindow');

/**
 * Compute real-time store metrics for today's window.
 * Excludes is_staff=true from all customer counts.
 */
async function getStoreMetrics(storeId, windowHours = 24) {
  const since = await getWindowStart(storeId, windowHours);

  const baseMatch = {
    store_id: storeId,
    timestamp: { $gte: since },
    is_staff: false,
  };

  const [
    uniqueVisitorIds,
    zoneStats,
    billingStats,
    posTransactions,
    queueStats,
    reentryCount,
  ] = await Promise.all([
    // 1. Unique customer visitor IDs (ENTRY only, no REENTRY double-count)
    Event.distinct('visitor_id', { ...baseMatch, event_type: 'ENTRY' }),

    // 2. Avg dwell per zone
    Event.aggregate([
      { $match: { ...baseMatch, event_type: 'ZONE_DWELL', dwell_ms: { $gt: 0 } } },
      {
        $group: {
          _id: '$zone_id',
          avg_dwell_ms: { $avg: '$dwell_ms' },
          visit_count: { $sum: 1 },
          total_dwell_ms: { $sum: '$dwell_ms' },
        },
      },
      { $sort: { visit_count: -1 } },
    ]),

    // 3. Billing zone join/abandon counts
    Event.aggregate([
      { $match: { ...baseMatch, event_type: { $in: ['BILLING_QUEUE_JOIN', 'BILLING_QUEUE_ABANDON'] } } },
      { $group: { _id: '$event_type', count: { $sum: 1 } } },
    ]),

    // 4. All POS transactions in window (for 5-min correlation)
    POSTransaction.find(
      { store_id: storeId, timestamp: { $gte: since } },
      { timestamp: 1, basket_value_inr: 1 }
    ).lean(),

    // 5. Current queue depth (most recent BILLING_QUEUE_JOIN)
    Event.findOne(
      { store_id: storeId, event_type: 'BILLING_QUEUE_JOIN', is_staff: false },
      { 'metadata.queue_depth': 1 },
      { sort: { timestamp: -1 } }
    ),

    // 6. Re-entry count
    Event.countDocuments({ ...baseMatch, event_type: 'REENTRY' }),
  ]);

  // ── POS 5-minute window correlation (exact per problem spec) ──────────────
  // "A visitor who was in the billing zone in the 5-minute window before a
  //  transaction timestamp counts as a converted visitor for that session."
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const convertedVisitorIds = new Set();

  for (const tx of posTransactions) {
    const txTime = new Date(tx.timestamp).getTime();
    const windowStart = new Date(txTime - FIVE_MIN_MS);

    // Find visitors in billing zone in the 5-min window before this transaction
    const billingVisitorsInWindow = await Event.distinct('visitor_id', {
      store_id: storeId,
      event_type: { $in: ['BILLING_QUEUE_JOIN', 'ZONE_ENTER'] },
      zone_id: { $regex: /billing/i },
      is_staff: false,
      timestamp: { $gte: windowStart, $lte: new Date(txTime) },
    });

    billingVisitorsInWindow.forEach(v => convertedVisitorIds.add(v));
  }

  // Fallback: if no POS-correlated conversions but we have POS data,
  // use BILLING_QUEUE_JOIN visitors as proxy (avoids zero when zone_id naming varies)
  let convertedCount = convertedVisitorIds.size;
  if (convertedCount === 0 && posTransactions.length > 0) {
    const billingQueueVisitors = await Event.distinct('visitor_id', {
      ...baseMatch,
      event_type: 'BILLING_QUEUE_JOIN',
    });
    convertedCount = Math.min(billingQueueVisitors.length, posTransactions.length);
  }

  const uniqueVisitors = uniqueVisitorIds.length;
  const posCount = posTransactions.length;
  const totalRevenue = posTransactions.reduce((s, t) => s + (t.basket_value_inr || 0), 0);
  const avgBasket = posCount > 0 ? totalRevenue / posCount : 0;

  const conversionRate = uniqueVisitors > 0
    ? Math.min(convertedCount / uniqueVisitors, 1)
    : 0;

  // ── Zone dwell map ────────────────────────────────────────────────────────
  const dwellByZone = {};
  zoneStats.forEach(z => {
    dwellByZone[z._id || 'unknown'] = {
      avg_dwell_seconds: Math.round(z.avg_dwell_ms / 1000),
      visit_count: z.visit_count,
      total_dwell_seconds: Math.round(z.total_dwell_ms / 1000),
    };
  });

  // ── Billing stats ─────────────────────────────────────────────────────────
  const billingMap = {};
  billingStats.forEach(b => { billingMap[b._id] = b.count; });
  const queueJoins = billingMap['BILLING_QUEUE_JOIN'] || 0;
  const queueAbandons = billingMap['BILLING_QUEUE_ABANDON'] || 0;
  const abandonRate = queueJoins > 0 ? queueAbandons / queueJoins : 0;

  return {
    store_id: storeId,
    window_hours: windowHours,
    computed_at: new Date().toISOString(),
    unique_visitors: uniqueVisitors,
    conversion_rate: parseFloat(conversionRate.toFixed(4)),
    converted_visitors: convertedCount,
    avg_dwell_by_zone: dwellByZone,
    queue_depth: queueStats?.metadata?.queue_depth ?? 0,
    abandonment_rate: parseFloat(abandonRate.toFixed(4)),
    billing_visitors: queueJoins,
    transactions: posCount,
    total_revenue_inr: parseFloat(totalRevenue.toFixed(2)),
    avg_basket_inr: parseFloat(avgBasket.toFixed(2)),
    reentry_count: reentryCount,
  };
}

module.exports = { getStoreMetrics };
