const crypto = require('crypto');
const { getDatabase } = require('../config/database');

const clientsByTeam = new Map();
const broadcastCursorByTeam = new Map();
let bridgeTimer = null;

function newEventId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${crypto.randomBytes(12).toString('hex')}`;
}

function addClient(teamId, response, initialCursor = 0) {
  const key = String(teamId);
  if (!clientsByTeam.has(key)) clientsByTeam.set(key, new Set());
  clientsByTeam.get(key).add(response);
  const cursor = Number(initialCursor) || 0;
  if (!broadcastCursorByTeam.has(key) || Number(broadcastCursorByTeam.get(key)) < cursor) broadcastCursorByTeam.set(key, cursor);
  startEventBridge();
  return () => {
    const clients = clientsByTeam.get(key);
    if (!clients) return;
    clients.delete(response);
    if (!clients.size) {
      clientsByTeam.delete(key);
      broadcastCursorByTeam.delete(key);
    }
  };
}

function sendSse(response, event) {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.action || 'workspace.updated'}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function publish(teamId, event) {
  const key = String(teamId);
  const eventId = Number(event?.id || 0);
  if (eventId > Number(broadcastCursorByTeam.get(key) || 0)) broadcastCursorByTeam.set(key, eventId);
  const clients = clientsByTeam.get(key);
  if (!clients) return;
  for (const response of [...clients]) {
    try { sendSse(response, event); } catch (_) { clients.delete(response); }
  }
}

function eventFromRow(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch (_) {}
  const operator = row.operator_user_id
    ? getDatabase().prepare('SELECT display_name, username FROM users WHERE id = ?').get(row.operator_user_id)
    : null;
  return {
    id: Number(row.id), eventId: row.event_id, teamId: row.team_id,
    entityType: row.entity_type, entityId: row.entity_id, action: row.action,
    entityVersion: Number(row.entity_version || 0), operatorUserId: row.operator_user_id,
    operatorName: operator?.display_name || operator?.username || '',
    operatorUsername: operator?.username || '', requestId: row.request_id, payload, createdAt: row.created_at
  };
}

// When multiple Node processes share the same database, each process bridges
// events written by the other processes to its own local SSE connections.
function pollSharedEvents() {
  if (!clientsByTeam.size) return;
  try {
    const db = getDatabase();
    const read = db.prepare('SELECT * FROM sync_events WHERE team_id = ? AND id > ? ORDER BY id ASC LIMIT 500');
    for (const [teamId] of clientsByTeam) {
      const cursor = Number(broadcastCursorByTeam.get(teamId) || 0);
      const rows = read.all(teamId, cursor);
      rows.forEach(row => publish(teamId, eventFromRow(row)));
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') console.warn('[SyncHub] shared event bridge failed', error.message);
  }
}

function startEventBridge() {
  if (bridgeTimer) return;
  bridgeTimer = setInterval(pollSharedEvents, 1000);
  bridgeTimer.unref?.();
}

function createSyncEvent(db, {
  teamId, entityType = 'workspace', entityId = null, action = 'workspace.updated',
  entityVersion = 0, operatorUserId = null, requestId = null, payload = {}
}) {
  const eventId = newEventId();
  const result = db.prepare(`INSERT INTO sync_events
    (event_id, team_id, entity_type, entity_id, action, entity_version, operator_user_id, request_id, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, teamId, entityType, entityId, action, entityVersion, operatorUserId, requestId, JSON.stringify(payload || {}));
  return {
    id: Number(result.lastInsertRowid), eventId, teamId, entityType, entityId,
    action, entityVersion, operatorUserId, operatorName: operatorName(db, operatorUserId),
    operatorUsername: operatorUsername(db, operatorUserId), requestId, payload, createdAt: new Date().toISOString()
  };
}

function operatorName(db, userId) {
  if (!userId) return '';
  const user = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(userId);
  return user?.display_name || user?.username || '';
}

function operatorUsername(db, userId) {
  if (!userId) return '';
  return db.prepare('SELECT username FROM users WHERE id = ?').get(userId)?.username || '';
}

function publishSyncNotification(teamId, {
  action = 'sync.operation.completed', operatorUserId = null, operatorName: name = '',
  operatorUsername: username = '', payload = {}, requestId = null
} = {}) {
  const eventId = newEventId();
  publish(teamId, {
    id: 0, eventId, teamId, entityType: 'sync_notification', entityId: null, action,
    entityVersion: 0, operatorUserId, operatorName: name, operatorUsername: username,
    requestId, payload, createdAt: new Date().toISOString()
  });
}

module.exports = {
  addClient, publish, sendSse, createSyncEvent, newEventId, publishSyncNotification,
  operatorName, operatorUsername
};
