const { Event } = require('../models');
const { getConnectionStatus } = require('../db');

/**
 * Returns service health including per-store last event timestamps
 * and STALE_FEED warnings for stores with > 10 min lag.
 */
async function getHealth() {
  const start = Date.now();
  const dbStatus = getConnectionStatus();

  let storeFeeds = [];
  let storeCount = 0;

  if (dbStatus.connected) {
    try {
      // Get last event per store
      const storeLastEvents = await Event.aggregate([
        {
          $group: {
            _id: '$store_id',
            last_event_at: { $max: '$timestamp' },
            total_events: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      storeCount = storeLastEvents.length;
      const now = Date.now();

      storeFeeds = storeLastEvents.map(s => {
        const lagMs = now - new Date(s.last_event_at).getTime();
        const lagMin = lagMs / 60000;
        return {
          store_id: s._id,
          last_event_at: s.last_event_at,
          lag_minutes: parseFloat(lagMin.toFixed(1)),
          total_events: s.total_events,
          status: lagMin > 10 ? 'STALE_FEED' : 'OK',
        };
      });
    } catch (err) {
      // DB query failed but connection ok — return partial health
    }
  }

  const staleFeeds = storeFeeds.filter(s => s.status === 'STALE_FEED');

  return {
    status: dbStatus.connected ? (staleFeeds.length > 0 ? 'DEGRADED' : 'OK') : 'UNHEALTHY',
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    response_time_ms: Date.now() - start,
    database: {
      status: dbStatus.readyStateLabel,
      connected: dbStatus.connected,
    },
    stores: {
      count: storeCount,
      stale_feed_count: staleFeeds.length,
      feeds: storeFeeds,
    },
    warnings: staleFeeds.map(s => ({
      type: 'STALE_FEED',
      store_id: s.store_id,
      lag_minutes: s.lag_minutes,
      message: `No events received from ${s.store_id} for ${s.lag_minutes} minutes`,
    })),
  };
}

module.exports = { getHealth };
