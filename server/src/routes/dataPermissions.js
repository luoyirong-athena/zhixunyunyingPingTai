'use strict';

const express = require('express');
const crypto = require('crypto');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext } = require('../middleware/team');
const { createSyncEvent, publish } = require('../services/syncHub');
const { isAdmin, resolveCustomerOwnerId } = require('../services/dataPermissions');

const router = express.Router();
router.use(authRequired, resolveTeamContext);

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function workspaceCustomers(db, teamId) {
  const row = db.prepare('SELECT state_json FROM workspace_states WHERE team_id = ?').get(teamId);
  const state = parseJson(row?.state_json, {});
  return Array.isArray(state.customers) ? state.customers : [];
}

function customerById(db, teamId, customerId) {
  return workspaceCustomers(db, teamId).find((item) => String(item?.id ?? '') === String(customerId ?? '')) || null;
}

function teamMember(db, teamId, userId) {
  return db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.avatar_url, tm.role team_role
    FROM team_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ? AND tm.user_id = ? AND tm.status = 'active' LIMIT 1`).get(teamId, userId);
}

function requestRows(db, req) {
  const params = [req.team.id];
  let visibility = '';
  if (!isAdmin(req)) {
    visibility = ' AND (p.owner_user_id = ? OR p.requester_user_id = ?)';
    params.push(req.user.id, req.user.id);
  }
  return db.prepare(`SELECT p.*,
      requester.username requester_username, requester.display_name requester_display_name, requester.avatar_url requester_avatar_url,
      owner.username owner_username, owner.display_name owner_display_name, owner.avatar_url owner_avatar_url,
      decider.username decided_by_username, decider.display_name decided_by_display_name
    FROM customer_data_permissions p
    LEFT JOIN users requester ON requester.id = p.requester_user_id
    LEFT JOIN users owner ON owner.id = p.owner_user_id
    LEFT JOIN users decider ON decider.id = p.decided_by_user_id
    WHERE p.team_id = ? ${visibility}
    ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
      p.updated_at DESC, p.id DESC`).all(...params);
}

function serializeRequest(row, customers) {
  const customer = customers.find((item) => String(item?.id ?? '') === String(row.customer_id));
  return {
    id: Number(row.id),
    customerId: row.customer_id,
    customerName: customer?.name || `客户 #${row.customer_id}`,
    customerProvince: customer?.province || '',
    customerStatus: customer?.sales_status || customer?.status || '',
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_display_name || row.owner_username || `用户 #${row.owner_user_id}`,
    ownerUsername: row.owner_username || '',
    requesterUserId: row.requester_user_id,
    requesterName: row.requester_display_name || row.requester_username || `用户 #${row.requester_user_id}`,
    requesterUsername: row.requester_username || '',
    status: row.status,
    reason: row.request_reason || '',
    decisionNote: row.decision_note || '',
    decidedByName: row.decided_by_display_name || row.decided_by_username || '',
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    updatedAt: row.updated_at
  };
}

function recordPermissionEvent(db, req, row, action, detail = {}) {
  const rid = String(req.get('X-Request-Id') || crypto.randomUUID()).slice(0, 100);
  const payload = {
    permissionId: Number(row.id), customerId: row.customer_id,
    ownerUserId: row.owner_user_id, requesterUserId: row.requester_user_id,
    status: row.status, ...detail
  };
  const event = createSyncEvent(db, {
    teamId: req.team.id,
    entityType: 'customer_permission',
    entityId: String(row.id),
    action,
    entityVersion: 1,
    operatorUserId: req.user.id,
    requestId: rid,
    payload
  });
  db.prepare(`INSERT INTO operation_logs
    (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
    VALUES (?, ?, 'customer_permission', ?, ?, ?, ?, ?, ?)`).run(
      req.team.id, req.user.id, String(row.id), action, JSON.stringify(payload), rid,
      req.ip || '', req.get('user-agent') || ''
    );
  publish(req.team.id, event);
  return event;
}

router.get('/overview', (req, res) => {
  const db = getDatabase();
  const customers = workspaceCustomers(db, req.team.id);
  const members = db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.avatar_url, tm.role team_role
    FROM team_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ? AND tm.status = 'active'
    ORDER BY CASE WHEN u.role = 'admin' OR tm.role = 'admin' THEN 0 ELSE 1 END,
      COALESCE(NULLIF(u.display_name, ''), u.username), u.id`).all(req.team.id).map((member) => ({
        id: member.id,
        username: member.username,
        displayName: member.display_name || member.username,
        role: member.role,
        teamRole: member.team_role,
        avatarUrl: member.avatar_url || ''
      }));
  const requests = requestRows(db, req).map((row) => serializeRequest(row, customers));
  const customerSummaries = customers.map((customer) => {
    const ownerUserId = resolveCustomerOwnerId(db, req.team.id, customer);
    const owner = members.find((member) => String(member.id) === String(ownerUserId));
    return {
      id: String(customer.id ?? ''),
      name: customer.name || '未命名客户',
      province: customer.province || '',
      salesStatus: customer.sales_status || customer.status || '',
      ownerUserId: ownerUserId || null,
      ownerName: owner?.displayName || customer.createdBy || customer.created_by_name || '团队共享'
    };
  });
  res.json({
    isAdmin: isAdmin(req),
    currentUserId: req.user.id,
    members,
    customers: customerSummaries,
    requests,
    pendingForMe: requests.filter((item) => item.status === 'pending' && (isAdmin(req) || String(item.ownerUserId) === String(req.user.id))).length,
    approvedForMe: requests.filter((item) => item.status === 'approved' && String(item.requesterUserId) === String(req.user.id)).length
  });
});

router.post('/request', (req, res) => {
  const db = getDatabase();
  const customerId = String(req.body?.customerId ?? '').trim();
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (!customerId) return res.status(400).json({ error: '请选择需要申请权限的客户' });
  const customer = customerById(db, req.team.id, customerId);
  if (!customer) return res.status(404).json({ error: '客户不存在或已被删除' });
  const ownerUserId = resolveCustomerOwnerId(db, req.team.id, customer);
  if (!ownerUserId) return res.status(400).json({ error: '该客户为团队共享数据，无需申请编辑权限' });
  if (String(ownerUserId) === String(req.user.id)) return res.status(400).json({ error: '您是该客户的创建人，无需申请权限' });
  if (isAdmin(req)) return res.status(400).json({ error: '系统管理员默认拥有全部客户数据权限' });
  if (!teamMember(db, req.team.id, ownerUserId)) return res.status(400).json({ error: '客户创建人不在当前团队，暂时无法发起申请' });

  db.prepare(`INSERT INTO customer_data_permissions
      (team_id, customer_id, owner_user_id, requester_user_id, status, request_reason, requested_at, decided_at, decided_by_user_id, decision_note, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP, NULL, NULL, '', CURRENT_TIMESTAMP)
    ON CONFLICT(team_id, customer_id, requester_user_id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      status = CASE WHEN customer_data_permissions.status = 'approved' THEN 'approved' ELSE 'pending' END,
      request_reason = excluded.request_reason,
      requested_at = CASE WHEN customer_data_permissions.status = 'approved' THEN customer_data_permissions.requested_at ELSE CURRENT_TIMESTAMP END,
      decided_at = CASE WHEN customer_data_permissions.status = 'approved' THEN customer_data_permissions.decided_at ELSE NULL END,
      decided_by_user_id = CASE WHEN customer_data_permissions.status = 'approved' THEN customer_data_permissions.decided_by_user_id ELSE NULL END,
      decision_note = CASE WHEN customer_data_permissions.status = 'approved' THEN customer_data_permissions.decision_note ELSE '' END,
      updated_at = CURRENT_TIMESTAMP`).run(req.team.id, customerId, Number(ownerUserId), req.user.id, reason);
  const row = db.prepare('SELECT * FROM customer_data_permissions WHERE team_id = ? AND customer_id = ? AND requester_user_id = ?')
    .get(req.team.id, customerId, req.user.id);
  recordPermissionEvent(db, req, row, row.status === 'approved' ? 'customer.permission_already_approved' : 'customer.permission_requested', { customerName: customer.name || '' });
  const serialized = serializeRequest(requestRows(db, req).find((item) => item.id === row.id) || row, workspaceCustomers(db, req.team.id));
  res.status(row.status === 'approved' ? 200 : 201).json(serialized);
});

router.patch('/:id', (req, res) => {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM customer_data_permissions WHERE id = ? AND team_id = ?').get(req.params.id, req.team.id);
  if (!row) return res.status(404).json({ error: '权限申请不存在' });
  const action = String(req.body?.action || '').trim();
  if (!['approve', 'reject', 'revoke'].includes(action)) return res.status(400).json({ error: '不支持的权限操作' });
  const ownerAllowed = String(row.owner_user_id) === String(req.user.id);
  if (!isAdmin(req) && !ownerAllowed) return res.status(403).json({ error: '只有客户创建人或系统管理员可以处理该权限' });
  if (action === 'revoke' && row.status !== 'approved') return res.status(400).json({ error: '当前权限不是已授权状态' });
  if ((action === 'approve' || action === 'reject') && row.status !== 'pending' && !isAdmin(req)) {
    return res.status(400).json({ error: '该申请已经处理' });
  }
  const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'revoked';
  const note = String(req.body?.note || '').trim().slice(0, 500);
  db.prepare(`UPDATE customer_data_permissions SET status = ?, decision_note = ?, decided_by_user_id = ?,
    decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, note, req.user.id, row.id);
  const updated = db.prepare('SELECT * FROM customer_data_permissions WHERE id = ?').get(row.id);
  const eventAction = status === 'approved' ? 'customer.permission_approved' : status === 'rejected' ? 'customer.permission_rejected' : 'customer.permission_revoked';
  recordPermissionEvent(db, req, updated, eventAction);
  const full = requestRows(db, req).find((item) => item.id === updated.id) || updated;
  res.json(serializeRequest(full, workspaceCustomers(db, req.team.id)));
});

router.post('/admin/grant', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅系统管理员可以直接配置授权' });
  const db = getDatabase();
  const customerId = String(req.body?.customerId ?? '').trim();
  const requesterUserId = Number(req.body?.userId);
  const grant = req.body?.grant !== false;
  if (!customerId || !Number.isInteger(requesterUserId)) return res.status(400).json({ error: '请选择客户和用户' });
  const customer = customerById(db, req.team.id, customerId);
  const requester = teamMember(db, req.team.id, requesterUserId);
  if (!customer) return res.status(404).json({ error: '客户不存在或已被删除' });
  if (!requester) return res.status(404).json({ error: '团队成员不存在' });
  const ownerUserId = resolveCustomerOwnerId(db, req.team.id, customer);
  if (!ownerUserId) return res.status(400).json({ error: '该客户为团队共享数据，无需授权' });
  if (String(ownerUserId) === String(requesterUserId)) return res.status(400).json({ error: '客户创建人默认拥有编辑权限' });
  const status = grant ? 'approved' : 'revoked';
  db.prepare(`INSERT INTO customer_data_permissions
      (team_id, customer_id, owner_user_id, requester_user_id, status, request_reason, decision_note, requested_at, decided_at, decided_by_user_id, updated_at)
    VALUES (?, ?, ?, ?, ?, '管理员直接配置', '管理员直接配置', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(team_id, customer_id, requester_user_id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id, status = excluded.status,
      decision_note = excluded.decision_note, decided_at = CURRENT_TIMESTAMP,
      decided_by_user_id = excluded.decided_by_user_id, updated_at = CURRENT_TIMESTAMP`).run(
        req.team.id, customerId, Number(ownerUserId), requesterUserId, status, req.user.id
      );
  const row = db.prepare('SELECT * FROM customer_data_permissions WHERE team_id = ? AND customer_id = ? AND requester_user_id = ?')
    .get(req.team.id, customerId, requesterUserId);
  recordPermissionEvent(db, req, row, grant ? 'customer.permission_approved' : 'customer.permission_revoked', { adminManaged: true });
  const full = requestRows(db, req).find((item) => item.id === row.id) || row;
  res.json(serializeRequest(full, workspaceCustomers(db, req.team.id)));
});

module.exports = router;
