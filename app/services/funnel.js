const { Event, POSTransaction } = require('../models');
const { getWindowStart } = require('./timeWindow');

/**
 * Build the conversion funnel for a store.
 * Unit is SESSION (visitor), not raw events.
 * Re-entries do not double-count the same visitor.
 *
 * Funnel stages:
 *   Entry → Zone Visit → Billing Queue → Purchase
 */
async function getStoreFunnel(storeId, windowHours = 24) {
  const since = await getWindowStart(storeId, windowHours);

  const baseMatch = {
    store_id: storeId,
    timestamp: { $gte: since },
    is_staff: false,
  };

  // ── Stage 1: Unique entering visitors (ENTRY, no re-entry inflation) ──────
  // We only count the FIRST ENTRY per visitor_id (not REENTRY events)
  const entryVisitors = await Event.distinct('visitor_id', {
    ...baseMatch,
    event_type: 'ENTRY',
  });
  const totalEntries = entryVisitors.length;

  // ── Stage 2: Visitors who visited at least one zone ──────────────────────
  let zoneVisitors = await Event.distinct('visitor_id', {
    ...baseMatch,
    event_type: { $in: ['ZONE_ENTER', 'ZONE_DWELL'] },
    visitor_id: { $in: entryVisitors },
  });
  if (zoneVisitors.length === 0 && totalEntries > 0) {
    zoneVisitors = await Event.distinct('visitor_id', {
      ...baseMatch,
      event_type: { $in: ['ZONE_ENTER', 'ZONE_DWELL'] },
    });
  }
  const totalZoneVisits = zoneVisitors.length;

  // ── Stage 3: Visitors who joined billing queue ────────────────────────────
  let billingVisitors = await Event.distinct('visitor_id', {
    ...baseMatch,
    event_type: 'BILLING_QUEUE_JOIN',
    visitor_id: { $in: entryVisitors },
  });
  if (billingVisitors.length === 0 && totalEntries > 0) {
    billingVisitors = await Event.distinct('visitor_id', {
      ...baseMatch,
      event_type: 'BILLING_QUEUE_JOIN',
    });
  }
  const totalBillingQueue = billingVisitors.length;

  // ── Stage 4: Visitors who converted (POS correlation) ────────────────────
  // A visitor counts as converted if:
  //   - They were in billing zone within 5 min before a POS transaction
  // We approximate: count POS transactions in window, cap at billing visitors
  const posCount = await POSTransaction.countDocuments({
    store_id: storeId,
    timestamp: { $gte: since },
  });

  // Converted = min(posCount, billingVisitors) — can't have more purchases than POS records
  const totalPurchased = Math.min(posCount, totalBillingQueue);
  const zonePctCount = Math.min(totalZoneVisits, totalEntries);
  const billingPctCount = Math.min(totalBillingQueue, totalEntries);
  const purchasedPctCount = Math.min(totalPurchased, totalEntries);

  // ── Drop-off rates ────────────────────────────────────────────────────────
  const dropoffs = {
    entry_to_zone:
      totalEntries > 0
        ? parseFloat(((1 - zonePctCount / totalEntries) * 100).toFixed(2))
        : 0,
    zone_to_billing:
      totalZoneVisits > 0
        ? parseFloat(((1 - Math.min(totalBillingQueue, totalZoneVisits) / totalZoneVisits) * 100).toFixed(2))
        : 0,
    billing_to_purchase:
      totalBillingQueue > 0
        ? parseFloat(((1 - totalPurchased / totalBillingQueue) * 100).toFixed(2))
        : 0,
    overall:
      totalEntries > 0
        ? parseFloat(((1 - purchasedPctCount / totalEntries) * 100).toFixed(2))
        : 0,
  };

  // ── Zone breakdown (which zones are visited most before billing) ──────────
  const zoneBreakdown = await Event.aggregate([
    {
      $match: {
        ...baseMatch,
        event_type: 'ZONE_ENTER',
        visitor_id: { $in: entryVisitors },
      },
    },
    {
      $group: {
        _id: '$zone_id',
        unique_visitors: { $addToSet: '$visitor_id' },
        visit_count: { $sum: 1 },
      },
    },
    {
      $project: {
        zone_id: '$_id',
        unique_visitors: { $size: '$unique_visitors' },
        visit_count: 1,
        _id: 0,
      },
    },
    { $sort: { unique_visitors: -1 } },
    { $limit: 10 },
  ]);

  return {
    store_id: storeId,
    window_hours: windowHours,
    computed_at: new Date().toISOString(),
    funnel: [
      {
        stage: 'entry',
        label: 'Store Entry',
        count: totalEntries,
        pct_of_total: 100,
      },
      {
        stage: 'zone_visit',
        label: 'Zone Visit',
        count: totalZoneVisits,
        pct_of_total:
          totalEntries > 0
            ? parseFloat(((zonePctCount / totalEntries) * 100).toFixed(2))
            : 0,
      },
      {
        stage: 'billing_queue',
        label: 'Billing Queue',
        count: totalBillingQueue,
        pct_of_total:
          totalEntries > 0
            ? parseFloat(((billingPctCount / totalEntries) * 100).toFixed(2))
            : 0,
      },
      {
        stage: 'purchase',
        label: 'Purchase',
        count: totalPurchased,
        pct_of_total:
          totalEntries > 0
            ? parseFloat(((purchasedPctCount / totalEntries) * 100).toFixed(2))
            : 0,
      },
    ],
    drop_off_pct: dropoffs,
    zone_breakdown: zoneBreakdown,
    session_count: totalEntries,
    note:
      totalEntries === 0
        ? 'No visitor sessions in this window'
        : null,
  };
}

module.exports = { getStoreFunnel };
