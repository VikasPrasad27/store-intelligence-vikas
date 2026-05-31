const { Event, POSTransaction } = require('../models');

const SEVERITY = { INFO: 'INFO', WARN: 'WARN', CRITICAL: 'CRITICAL' };

/**
 * Detect active operational anomalies for a store.
 * Returns array of anomaly objects with severity + suggested_action.
 */
async function getStoreAnomalies(storeId) {
  const now = new Date();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const thirtyMinAgo = new Date(now - 30 * 60 * 1000);
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const anomalies = [];

  // ── 1. BILLING_QUEUE_SPIKE ────────────────────────────────────────────────
  // Current queue depth vs average over last 7 days
  const [recentQueueEvent, avgQueueDepth] = await Promise.all([
    Event.findOne(
      {
        store_id: storeId,
        event_type: 'BILLING_QUEUE_JOIN',
        is_staff: false,
        timestamp: { $gte: thirtyMinAgo },
      },
      { 'metadata.queue_depth': 1, timestamp: 1 },
      { sort: { timestamp: -1 } }
    ),
    Event.aggregate([
      {
        $match: {
          store_id: storeId,
          event_type: 'BILLING_QUEUE_JOIN',
          is_staff: false,
          timestamp: { $gte: sevenDaysAgo, $lt: todayStart },
          'metadata.queue_depth': { $ne: null },
        },
      },
      { $group: { _id: null, avg: { $avg: '$metadata.queue_depth' } } },
    ]),
  ]);

  const currentDepth = recentQueueEvent?.metadata?.queue_depth ?? 0;
  const historicAvg = avgQueueDepth[0]?.avg ?? 3; // default baseline of 3

  if (currentDepth > 0) {
    const multiplier = process.env.FOOTFALL_SPIKE_MULTIPLIER
      ? parseFloat(process.env.FOOTFALL_SPIKE_MULTIPLIER)
      : 2;

    if (currentDepth >= 10) {
      anomalies.push({
        type: 'BILLING_QUEUE_SPIKE',
        severity: SEVERITY.CRITICAL,
        current_value: currentDepth,
        baseline_value: Math.round(historicAvg),
        message: `Billing queue depth is ${currentDepth} — critically high`,
        suggested_action:
          'Open additional billing counters immediately. Alert floor manager.',
        detected_at: now.toISOString(),
      });
    } else if (currentDepth >= historicAvg * multiplier) {
      anomalies.push({
        type: 'BILLING_QUEUE_SPIKE',
        severity: SEVERITY.WARN,
        current_value: currentDepth,
        baseline_value: Math.round(historicAvg),
        message: `Billing queue depth (${currentDepth}) is ${multiplier}× the 7-day average (${Math.round(historicAvg)})`,
        suggested_action:
          'Consider opening an extra billing counter or redirecting customers.',
        detected_at: now.toISOString(),
      });
    }
  }

  // ── 2. CONVERSION_DROP ────────────────────────────────────────────────────
  // Today's conversion rate vs 7-day average
  const [todayVisitors, todayPOS, historicConversion] = await Promise.all([
    Event.distinct('visitor_id', {
      store_id: storeId,
      event_type: 'ENTRY',
      is_staff: false,
      timestamp: { $gte: todayStart },
    }).then(ids => ids.length),

    POSTransaction.countDocuments({
      store_id: storeId,
      timestamp: { $gte: todayStart },
    }),

    // 7-day daily conversion average
    Event.aggregate([
      {
        $match: {
          store_id: storeId,
          event_type: 'ENTRY',
          is_staff: false,
          timestamp: { $gte: sevenDaysAgo, $lt: todayStart },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          visitors: { $addToSet: '$visitor_id' },
        },
      },
      {
        $project: { day: '$_id', visitor_count: { $size: '$visitors' } },
      },
    ]),
  ]);

  const todayConversion =
    todayVisitors > 0 ? todayPOS / todayVisitors : null;

  if (historicConversion.length >= 3 && todayConversion !== null) {
    // Fetch POS for each historic day
    const historicPOSData = await POSTransaction.aggregate([
      {
        $match: {
          store_id: storeId,
          timestamp: { $gte: sevenDaysAgo, $lt: todayStart },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          count: { $sum: 1 },
        },
      },
    ]);

    const posMap = {};
    historicPOSData.forEach(p => { posMap[p._id] = p.count; });

    const dailyRates = historicConversion.map(d => {
      const pos = posMap[d.day] || 0;
      return d.visitor_count > 0 ? pos / d.visitor_count : 0;
    });

    const avgHistoricRate =
      dailyRates.reduce((s, r) => s + r, 0) / dailyRates.length;

    if (avgHistoricRate > 0.05 && todayConversion < avgHistoricRate * 0.7) {
      anomalies.push({
        type: 'CONVERSION_DROP',
        severity: todayConversion < avgHistoricRate * 0.5 ? SEVERITY.CRITICAL : SEVERITY.WARN,
        current_value: parseFloat(todayConversion.toFixed(4)),
        baseline_value: parseFloat(avgHistoricRate.toFixed(4)),
        message: `Today's conversion rate (${(todayConversion * 100).toFixed(1)}%) is significantly below 7-day average (${(avgHistoricRate * 100).toFixed(1)}%)`,
        suggested_action:
          'Review floor staff placement, check promotional signage, inspect billing counter operation.',
        detected_at: now.toISOString(),
      });
    }
  }

  // ── 3. DEAD_ZONE ──────────────────────────────────────────────────────────
  // Zones with no visits in the last 30 min (during open hours)
  const openHour = parseInt(process.env.STORE_OPEN_HOUR || 9);
  const closeHour = parseInt(process.env.STORE_CLOSE_HOUR || 21);
  const currentHour = now.getHours();
  const isStoreOpen = currentHour >= openHour && currentHour < closeHour;

  if (isStoreOpen && todayVisitors > 5) {
    // Get all zones that have seen traffic today
    const activeZonesToday = await Event.distinct('zone_id', {
      store_id: storeId,
      event_type: 'ZONE_ENTER',
      is_staff: false,
      timestamp: { $gte: todayStart },
      zone_id: { $ne: null },
    });

    // Zones active today but NOT in last 30 min
    const recentZones = await Event.distinct('zone_id', {
      store_id: storeId,
      event_type: 'ZONE_ENTER',
      is_staff: false,
      timestamp: { $gte: thirtyMinAgo },
      zone_id: { $ne: null },
    });

    const deadZones = activeZonesToday.filter(
      z => z && !recentZones.includes(z)
    );

    deadZones.forEach(zone => {
      anomalies.push({
        type: 'DEAD_ZONE',
        severity: SEVERITY.INFO,
        zone_id: zone,
        current_value: 0,
        baseline_value: null,
        message: `Zone "${zone}" has had no customer visits in the last 30 minutes`,
        suggested_action:
          'Check zone signage, lighting, and staff presence. Consider promotional activity to drive traffic.',
        detected_at: now.toISOString(),
      });
    });
  }

  // ── 4. HIGH_ABANDONMENT ───────────────────────────────────────────────────
  const abandonCount = await Event.countDocuments({
    store_id: storeId,
    event_type: 'BILLING_QUEUE_ABANDON',
    is_staff: false,
    timestamp: { $gte: oneHourAgo },
  });

  const queueJoinCount = await Event.countDocuments({
    store_id: storeId,
    event_type: 'BILLING_QUEUE_JOIN',
    is_staff: false,
    timestamp: { $gte: oneHourAgo },
  });

  if (queueJoinCount > 3) {
    const abandonRate = abandonCount / queueJoinCount;
    if (abandonRate > 0.4) {
      anomalies.push({
        type: 'HIGH_QUEUE_ABANDONMENT',
        severity: abandonRate > 0.6 ? SEVERITY.CRITICAL : SEVERITY.WARN,
        current_value: parseFloat(abandonRate.toFixed(4)),
        baseline_value: 0.15,
        message: `${(abandonRate * 100).toFixed(1)}% of billing queue visitors abandoned in the last hour`,
        suggested_action:
          'Reduce queue wait time by opening additional counters. Investigate billing system delays.',
        detected_at: now.toISOString(),
      });
    }
  }

  // ── 5. STALE_FEED check ───────────────────────────────────────────────────
  const lastEvent = await Event.findOne(
    { store_id: storeId },
    { timestamp: 1 },
    { sort: { timestamp: -1 } }
  );

  if (lastEvent) {
    const lagMs = now - new Date(lastEvent.timestamp);
    const lagMin = lagMs / 60000;
    if (lagMin > 10) {
      anomalies.push({
        type: 'STALE_FEED',
        severity: lagMin > 30 ? SEVERITY.CRITICAL : SEVERITY.WARN,
        current_value: Math.round(lagMin),
        baseline_value: 10,
        message: `No events received from store "${storeId}" for ${Math.round(lagMin)} minutes`,
        suggested_action:
          'Check camera connectivity, pipeline process health, and network status.',
        detected_at: now.toISOString(),
        last_event_at: lastEvent.timestamp,
      });
    }
  }

  return {
    store_id: storeId,
    computed_at: now.toISOString(),
    anomaly_count: anomalies.length,
    anomalies,
  };
}

module.exports = { getStoreAnomalies };
