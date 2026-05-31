const { Event } = require('../models');
const { getWindowStart } = require('./timeWindow');

/**
 * Generate zone heatmap data — normalised visit frequency + avg dwell (0–100).
 * Flags low-confidence if fewer than 20 sessions in window.
 */
async function getStoreHeatmap(storeId, windowHours = 24) {
  const since = await getWindowStart(storeId, windowHours);

  const baseMatch = {
    store_id: storeId,
    timestamp: { $gte: since },
    is_staff: false,
  };

  // Count total unique sessions for confidence flag
  const totalSessions = await Event.distinct('visitor_id', {
    ...baseMatch,
    event_type: 'ENTRY',
  }).then(ids => ids.length);

  // Aggregate: per zone — unique visitors, total visits, avg/max dwell
  const zoneData = await Event.aggregate([
    {
      $match: {
        ...baseMatch,
        event_type: { $in: ['ZONE_ENTER', 'ZONE_DWELL', 'ZONE_EXIT'] },
        zone_id: { $ne: null },
      },
    },
    {
      $group: {
        _id: '$zone_id',
        unique_visitors: { $addToSet: '$visitor_id' },
        total_visits: { $sum: 1 },
        avg_dwell_ms: {
          $avg: {
            $cond: [{ $gt: ['$dwell_ms', 0] }, '$dwell_ms', null],
          },
        },
        max_dwell_ms: { $max: '$dwell_ms' },
        total_dwell_ms: { $sum: '$dwell_ms' },
      },
    },
    {
      $project: {
        zone_id: '$_id',
        unique_visitor_count: { $size: '$unique_visitors' },
        total_visits: 1,
        avg_dwell_ms: { $ifNull: ['$avg_dwell_ms', 0] },
        max_dwell_ms: 1,
        total_dwell_ms: 1,
        _id: 0,
      },
    },
    { $sort: { unique_visitor_count: -1 } },
  ]);

  if (zoneData.length === 0) {
    return {
      store_id: storeId,
      window_hours: windowHours,
      computed_at: new Date().toISOString(),
      data_confidence: totalSessions < 20 ? 'LOW' : 'HIGH',
      session_count: totalSessions,
      zones: [],
      note: 'No zone events in this window',
    };
  }

  // Normalise visit counts and dwell to 0–100
  const maxVisits = Math.max(...zoneData.map(z => z.unique_visitor_count));
  const maxDwell = Math.max(...zoneData.map(z => z.avg_dwell_ms));

  const zones = zoneData.map(z => ({
    zone_id: z.zone_id,
    unique_visitors: z.unique_visitor_count,
    total_visits: z.total_visits,
    avg_dwell_seconds: Math.round((z.avg_dwell_ms || 0) / 1000),
    visit_intensity: maxVisits > 0
      ? Math.round((z.unique_visitor_count / maxVisits) * 100)
      : 0,
    dwell_intensity: maxDwell > 0
      ? Math.round(((z.avg_dwell_ms || 0) / maxDwell) * 100)
      : 0,
    // Combined heatmap score: weighted average
    heatmap_score: maxVisits > 0
      ? Math.round(
          (0.6 * (z.unique_visitor_count / maxVisits) +
            0.4 * ((z.avg_dwell_ms || 0) / (maxDwell || 1))) *
            100
        )
      : 0,
  }));

  return {
    store_id: storeId,
    window_hours: windowHours,
    computed_at: new Date().toISOString(),
    data_confidence: totalSessions < 20 ? 'LOW' : 'HIGH',
    session_count: totalSessions,
    zones,
  };
}

module.exports = { getStoreHeatmap };
