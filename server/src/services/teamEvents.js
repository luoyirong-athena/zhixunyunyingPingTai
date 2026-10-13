const crypto = require('crypto');
const { createSyncEvent, publish } = require('./syncHub');

function requestId(req, suffix = '') {
  const base = String(req.get?.('x-request-id') || req.body?.requestId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`));
  return suffix ? `${base}:${suffix}` : base;
}

function recordChange(db, req, {
  entityType,
  entityId,
  action,
  version = 1,
  before = null,
  after = null,
  payload = {},
  requestId: rid = requestId(req)
}) {
  const eventPayload = {
    ...(payload || {}),
    delta: { before, after }
  };
  const event = createSyncEvent(db, {
    teamId: req.team.id,
    entityType,
    entityId: entityId == null ? null : String(entityId),
    action,
    entityVersion: Number(version || 1),
    operatorUserId: req.user.id,
    requestId: rid,
    payload: eventPayload
  });
  db.prepare(`INSERT INTO operation_logs
    (team_id, operator_user_id, entity_type, entity_id, action, before_data, after_data, request_id, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      req.team.id,
      req.user.id,
      entityType,
      entityId == null ? null : String(entityId),
      action,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      rid,
      req.ip || '',
      req.get?.('user-agent') || ''
    );
  return event;
}

function publishEvents(teamId, events) {
  for (const event of events || []) publish(teamId, event);
}

module.exports = { requestId, recordChange, publishEvents };
