// mongo-init.js — runs once on first container start
db = db.getSiblingDB('store_intelligence');

db.createCollection('events');
db.createCollection('pos_transactions');
db.createCollection('stores');

// Indexes
db.events.createIndex({ event_id: 1 }, { unique: true });
db.events.createIndex({ store_id: 1, timestamp: -1 });
db.events.createIndex({ store_id: 1, event_type: 1, timestamp: -1 });
db.events.createIndex({ store_id: 1, visitor_id: 1, timestamp: 1 });
db.events.createIndex({ visitor_id: 1, event_type: 1 });

db.pos_transactions.createIndex({ transaction_id: 1 }, { unique: true });
db.pos_transactions.createIndex({ store_id: 1, timestamp: -1 });

db.stores.createIndex({ store_id: 1 }, { unique: true });

print('store_intelligence DB initialized');
