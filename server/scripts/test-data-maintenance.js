#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { runDataMaintenance } = require('../src/services/dataMaintenance');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE sync_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME
  );
  CREATE TABLE operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME
  );
  CREATE TABLE sync_queue_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status VARCHAR(20),
    completed_at DATETIME
  );
  CREATE TABLE sync_queue_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER
  );
  CREATE TABLE workspace_states (
    team_id INTEGER PRIMARY KEY,
    state_json TEXT,
    version INTEGER DEFAULT 0,
    updated_at DATETIME
  );
`);

db.prepare("INSERT INTO sync_events(created_at) VALUES (datetime('now', '-91 days'))").run();
db.prepare("INSERT INTO sync_events(created_at) VALUES (datetime('now', '-1 day'))").run();
db.prepare("INSERT INTO operation_logs(created_at) VALUES (datetime('now', '-366 days'))").run();
db.prepare("INSERT INTO operation_logs(created_at) VALUES (datetime('now', '-1 day'))").run();

const oldCompleted = db.prepare("INSERT INTO sync_queue_jobs(status, completed_at) VALUES ('completed', datetime('now', '-31 days'))").run().lastInsertRowid;
db.prepare('INSERT INTO sync_queue_batches(job_id) VALUES (?)').run(oldCompleted);
db.prepare("INSERT INTO sync_queue_jobs(status, completed_at) VALUES ('completed', datetime('now', '-1 day'))").run();
for (const status of ['pending', 'retrying', 'failed']) {
  const id = db.prepare('INSERT INTO sync_queue_jobs(status, completed_at) VALUES (?, NULL)').run(status).lastInsertRowid;
  db.prepare('INSERT INTO sync_queue_batches(job_id) VALUES (?)').run(id);
}
db.prepare('INSERT INTO workspace_states(team_id, state_json, version) VALUES (1, ?, 4)').run(JSON.stringify({
  capturePromotionTombstones: [
    { id: 'expired', promotedAt: '2020-01-01T00:00:00.000Z' },
    { id: 'current', promotedAt: new Date().toISOString() },
    { id: 'legacy-without-date' }
  ]
}));

const result = runDataMaintenance(db);
assert.equal(result.syncEvents, 1);
assert.equal(result.operationLogs, 1);
assert.equal(result.completedJobs, 1);
assert.equal(result.captureTombstones, 1);
assert.equal(db.prepare('SELECT COUNT(*) count FROM sync_events').get().count, 1);
assert.equal(db.prepare('SELECT COUNT(*) count FROM operation_logs').get().count, 1);
assert.equal(db.prepare("SELECT COUNT(*) count FROM sync_queue_jobs WHERE status='completed'").get().count, 1);
assert.equal(db.prepare("SELECT COUNT(*) count FROM sync_queue_jobs WHERE status IN ('pending','retrying','failed')").get().count, 3);
assert.equal(db.prepare('SELECT COUNT(*) count FROM sync_queue_batches').get().count, 3);
const state = JSON.parse(db.prepare('SELECT state_json FROM workspace_states WHERE team_id = 1').get().state_json);
assert.deepEqual(state.capturePromotionTombstones.map(item => item.id), ['current', 'legacy-without-date']);

db.close();
console.log(JSON.stringify({ result: 'ok', maintenance: result }));
