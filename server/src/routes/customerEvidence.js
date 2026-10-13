const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { createSyncEvent, publish } = require('../services/syncHub');
const { teamCustomers, computeCustomerPriority, activeStatusConfigs } = require('../services/priorityCustomers');
const { canWriteCustomer } = require('../services/dataPermissions');

const router = express.Router();
const DATA_DIR = path.resolve(process.env.ZHIXUN_CUSTOMER_EVIDENCE_DIR || path.join(__dirname, '..', '..', 'data', 'customer-evidence'));
const MAX_BYTES = 8 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']
]);
router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);

function requestId(req) {
  return String(req.get('X-Request-Id') || req.body?.requestId || crypto.randomUUID()).slice(0, 100);
}
function customerExists(db, teamId, customerId) {
  return teamCustomers(db, teamId).customers.some(customer => String(customer?.id) === String(customerId));
}
function customerForId(db, teamId, customerId) {
  return teamCustomers(db, teamId).customers.find(customer => String(customer?.id) === String(customerId));
}
function parseImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES) return null;
  return { mime, buffer, extension: MIME_EXTENSIONS.get(mime) };
}
function publicEvidence(row, req) {
  return {
    id: Number(row.id), customerId: String(row.customer_id), evidenceType: row.evidence_type,
    fileName: row.file_name, mimeType: row.mime_type, byteSize: Number(row.byte_size || 0),
    createdByUserId: row.created_by_user_id, createdAt: row.created_at,
    fileUrl: `/api/customers/${encodeURIComponent(row.customer_id)}/evidence/${row.id}/file`
  };
}
function activeRows(db, teamId, customerId) {
  return db.prepare(`SELECT * FROM customer_evidence
    WHERE team_id = ? AND customer_id = ? AND evidence_type = 'moments_order_screenshot' AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC`).all(teamId, String(customerId));
}
function response(db, req, customerId) {
  const rows = activeRows(db, req.team.id, customerId);
  return { customerId: String(customerId), count: rows.length, items: rows.map(row => publicEvidence(row, req)) };
}

router.get('/:customerId/evidence/:evidenceId/file', (req, res) => {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM customer_evidence WHERE team_id = ? AND customer_id = ? AND id = ? AND deleted_at IS NULL`).get(req.team.id, String(req.params.customerId), Number(req.params.evidenceId));
  if (!row) return res.status(404).json({ error: '截图不存在或已删除' });
  const root = path.resolve(DATA_DIR);
  const filePath = path.resolve(row.file_path);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath)) return res.status(404).json({ error: '截图文件不存在' });
  res.type(row.mime_type).sendFile(filePath);
});

router.get('/:customerId/evidence', (req, res) => {
  const db = getDatabase();
  if (!customerExists(db, req.team.id, req.params.customerId)) return res.status(404).json({ error: '客户不存在' });
  res.json(response(db, req, req.params.customerId));
});

router.post('/:customerId/evidence', (req, res) => {
  const db = getDatabase();
  const customerId = String(req.params.customerId);
  const customer = customerForId(db, req.team.id, customerId);
  if (!customer) return res.status(404).json({ error: '客户不存在' });
  if (!canWriteCustomer(db, req, customer)) return res.status(403).json({ error: '当前账号没有修改该客户的权限' });
  const image = parseImage(req.body?.dataUrl);
  if (!image) return res.status(400).json({ error: '仅支持 PNG、JPG、WEBP、GIF 图片，且单张不超过 8MB' });
  const rid = requestId(req);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const fileName = String(req.body?.fileName || `朋友圈客单量.${image.extension}`).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 180) || `朋友圈客单量.${image.extension}`;
  const storedName = `${req.team.id}_${customerId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${image.extension}`;
  const filePath = path.join(DATA_DIR, storedName);
  fs.writeFileSync(filePath, image.buffer, { flag: 'wx' });
  try {
    const result = db.transaction(() => {
      const insert = db.prepare(`INSERT INTO customer_evidence
        (team_id, customer_id, evidence_type, file_name, mime_type, file_path, byte_size, created_by_user_id, updated_by_user_id, version)
        VALUES (?, ?, 'moments_order_screenshot', ?, ?, ?, ?, ?, ?, 1)`).run(req.team.id, customerId, fileName, image.mime, filePath, image.buffer.length, req.user.id, req.user.id);
      const row = db.prepare('SELECT * FROM customer_evidence WHERE id = ?').get(insert.lastInsertRowid);
      const evidenceCount = activeRows(db, req.team.id, customerId).length;
      const customer = teamCustomers(db, req.team.id).customers.find(item => String(item?.id) === customerId);
      const configs = activeStatusConfigs(db, req.team.id);
      const beforePriority = computeCustomerPriority(customer, Math.max(0, evidenceCount - 1), configs);
      const afterPriority = computeCustomerPriority(customer, evidenceCount, configs);
      const syncEvent = createSyncEvent(db, {
        teamId: req.team.id, entityType: 'customer', entityId: customerId, action: 'customer.evidence_added',
        entityVersion: 1, operatorUserId: req.user.id, requestId: rid,
        payload: { customerId, evidenceId: Number(row.id), evidenceCount }
      });
      const priorityEvent = createSyncEvent(db, {
        teamId: req.team.id, entityType: 'customer', entityId: customerId, action: 'customer.priority_changed',
        entityVersion: 1, operatorUserId: req.user.id, requestId: `${rid}:priority`,
        payload: { customerId, customerName: customer?.name || '', reason: 'customer.evidence_added', before: beforePriority, after: afterPriority }
      });
      db.prepare(`INSERT INTO operation_logs
        (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'customer_evidence', ?, 'added', ?, ?, ?, ?)`).run(req.team.id, req.user.id, customerId, JSON.stringify({ evidenceId: Number(row.id), fileName }), rid, req.ip || '', req.get('user-agent') || '');
      db.prepare(`INSERT INTO operation_logs
        (team_id, operator_user_id, entity_type, entity_id, action, before_data, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'customer', ?, 'customer.priority_changed', ?, ?, ?, ?, ?)`).run(req.team.id, req.user.id, customerId, JSON.stringify(beforePriority), JSON.stringify(afterPriority), `${rid}:priority`, req.ip || '', req.get('user-agent') || '');
      return { row, events: [syncEvent, priorityEvent] };
    })();
    result.events.forEach(item => publish(req.team.id, item));
    res.status(201).json({ ...publicEvidence(result.row, req), ...response(db, req, customerId) });
  } catch (error) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    throw error;
  }
});

router.delete('/:customerId/evidence/:evidenceId', (req, res) => {
  const db = getDatabase();
  const customerId = String(req.params.customerId);
  const evidenceId = Number(req.params.evidenceId);
  const row = db.prepare(`SELECT * FROM customer_evidence WHERE team_id = ? AND customer_id = ? AND id = ? AND deleted_at IS NULL`).get(req.team.id, customerId, evidenceId);
  if (!row) return res.status(404).json({ error: '截图不存在或已删除' });
  const customer = customerForId(db, req.team.id, customerId);
  if (!customer) return res.status(404).json({ error: '客户不存在' });
  if (!canWriteCustomer(db, req, customer)) return res.status(403).json({ error: '当前账号没有修改该客户的权限' });
  const rid = requestId(req);
  const events = db.transaction(() => {
    const evidenceCountBefore = activeRows(db, req.team.id, customerId).length;
    db.prepare(`UPDATE customer_evidence SET deleted_at = CURRENT_TIMESTAMP, deleted_by_user_id = ?, updated_by_user_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.user.id, req.user.id, evidenceId);
    const evidenceCount = activeRows(db, req.team.id, customerId).length;
    const customer = teamCustomers(db, req.team.id).customers.find(item => String(item?.id) === customerId);
    const configs = activeStatusConfigs(db, req.team.id);
    const beforePriority = computeCustomerPriority(customer, evidenceCountBefore, configs);
    const afterPriority = computeCustomerPriority(customer, evidenceCount, configs);
    const syncEvent = createSyncEvent(db, {
      teamId: req.team.id, entityType: 'customer', entityId: customerId, action: 'customer.evidence_deleted',
      entityVersion: Number(row.version || 1) + 1, operatorUserId: req.user.id, requestId: rid,
      payload: { customerId, evidenceId, evidenceCount }
    });
    const priorityEvent = createSyncEvent(db, {
      teamId: req.team.id, entityType: 'customer', entityId: customerId, action: 'customer.priority_changed',
      entityVersion: Number(row.version || 1) + 1, operatorUserId: req.user.id, requestId: `${rid}:priority`,
      payload: { customerId, customerName: customer?.name || '', reason: 'customer.evidence_deleted', before: beforePriority, after: afterPriority }
    });
    db.prepare(`INSERT INTO operation_logs
      (team_id, operator_user_id, entity_type, entity_id, action, before_data, after_data, request_id, ip_address, user_agent)
      VALUES (?, ?, 'customer_evidence', ?, 'deleted', ?, ?, ?, ?, ?)`).run(req.team.id, req.user.id, customerId, JSON.stringify({ evidenceId, fileName: row.file_name }), JSON.stringify({ deleted: true }), rid, req.ip || '', req.get('user-agent') || '');
    db.prepare(`INSERT INTO operation_logs
      (team_id, operator_user_id, entity_type, entity_id, action, before_data, after_data, request_id, ip_address, user_agent)
      VALUES (?, ?, 'customer', ?, 'customer.priority_changed', ?, ?, ?, ?, ?)`).run(req.team.id, req.user.id, customerId, JSON.stringify(beforePriority), JSON.stringify(afterPriority), `${rid}:priority`, req.ip || '', req.get('user-agent') || '');
    return [syncEvent, priorityEvent];
  })();
  events.forEach(item => publish(req.team.id, item));
  res.json(response(db, req, customerId));
});

module.exports = router;
