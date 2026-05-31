const { Event, POSTransaction } = require('../models');

async function getWindowStart(storeId, windowHours = 24) {
  const wallClockSince = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const [latestEvent, latestPos] = await Promise.all([
    Event.findOne({ store_id: storeId }, { timestamp: 1 }, { sort: { timestamp: -1 } }).lean(),
    POSTransaction.findOne({ store_id: storeId }, { timestamp: 1 }, { sort: { timestamp: -1 } }).lean(),
  ]);

  const latestTimestamps = [latestEvent?.timestamp, latestPos?.timestamp]
    .filter(Boolean)
    .map(ts => new Date(ts).getTime());

  if (latestTimestamps.length === 0) {
    return wallClockSince;
  }

  const latest = new Date(Math.max(...latestTimestamps));
  if (latest < wallClockSince) {
    return new Date(latest.getTime() - windowHours * 60 * 60 * 1000);
  }

  return wallClockSince;
}

module.exports = { getWindowStart };
