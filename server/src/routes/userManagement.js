'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDatabase, DEFAULT_TEAM_CODE } = require('../config/database');
const { authRequired, adminRequired, createToken } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, adminRequired);

function normalizeText(value, max = 100) {
  return String(value ?? '').trim().slice(0, max);
}

function serializeUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role || 'user',
    status: row.status || 'active',
    phone: row.phone || '',
    passwordHint: row.password_hint || '',
    passwordResetRequired: Boolean(row.password_reset_required),
    passwordResetStatus: row.password_reset_status || null,
    passwordResetRequestedAt: row.password_reset_requested_at || null,
    passwordResetRequestedBy: row.password_reset_requested_by_name || row.password_reset_requested_by_username || null,
    passwordResetProcessedAt: row.password_reset_processed_at || null,
    passwordResetProcessedBy: row.password_reset_processed_by_name || row.password_reset_processed_by_username || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    teamRole: row.team_role || (row.role === 'admin' ? 'admin' : 'member')
  };
}

function defaultTeam(db) {
  return db.prepare("SELECT id, code FROM teams WHERE code = ? AND status = 'active'").get(DEFAULT_TEAM_CODE);
}

function activeAdminCount(db) {
  return db.prepare("SELECT COUNT(*) count FROM users WHERE role = 'admin' AND COALESCE(status, 'active') = 'active'").get().count;
}

function logAccountEvent(db, req, action, userId, detail = {}) {
  const team = defaultTeam(db);
  if (!team) return;
  const payload = { userId: Number(userId), ...detail };
  const requestId = String(req.get('X-Request-Id') || crypto.randomUUID()).slice(0, 100);
  db.prepare(`INSERT INTO operation_logs
    (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
    VALUES (?, ?, 'user_account', ?, ?, ?, ?, ?, ?)`).run(
    team.id, req.user.id, String(userId), action, JSON.stringify(payload), requestId,
    req.ip || '', req.get('user-agent') || ''
  );
}

function syncTeamMembership(db, userId, role, status = 'active') {
  const team = defaultTeam(db);
  if (!team) return;
  db.prepare(`INSERT INTO team_members (team_id, user_id, role, status)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role, status = excluded.status`).run(
    team.id, userId, role === 'admin' ? 'admin' : 'member', status
  );
}

function isSuperAdmin(req) {
  return req.user && req.user.username === (process.env.DEMO_ADMIN_USERNAME || 'demo');
}

router.get('/', (req, res) => {
  const db = getDatabase();
  const rows = db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.status, u.phone,
      u.password_hint, u.password_reset_required, u.created_at, u.updated_at, tm.role team_role,
      pr.status password_reset_status, pr.requested_at password_reset_requested_at,
      pr.processed_at password_reset_processed_at,
      requested_by.username password_reset_requested_by_username,
      requested_by.display_name password_reset_requested_by_name,
      processed_by.username password_reset_processed_by_username,
      processed_by.display_name password_reset_processed_by_name
    FROM users u
    LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = (SELECT id FROM teams WHERE code = ? LIMIT 1)
    LEFT JOIN password_reset_requests pr ON pr.id = (
      SELECT id FROM password_reset_requests WHERE target_user_id = u.id ORDER BY id DESC LIMIT 1
    )
    LEFT JOIN users requested_by ON requested_by.id = pr.requested_by_user_id
    LEFT JOIN users processed_by ON processed_by.id = pr.processed_by_user_id
    WHERE COALESCE(u.status, 'active') <> 'deleted'
      ${isSuperAdmin(req) ? '' : "AND (u.role != 'admin' OR u.id = ?)"}
    ORDER BY CASE WHEN COALESCE(u.status, 'active') = 'active' THEN 0 ELSE 1 END,
      CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END,
      COALESCE(NULLIF(u.display_name, ''), u.username), u.id`)
    .all(...(isSuperAdmin(req)
      ? [DEFAULT_TEAM_CODE]
      : [DEFAULT_TEAM_CODE, req.user.id]));
  res.json({ users: rows.map(serializeUser) });
});

function generateTemporaryPassword() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*'];
  const pick = (chars) => chars[crypto.randomInt(0, chars.length)];
  const chars = groups.map(pick);
  const all = groups.join('');
  while (chars.length < 14) chars.push(pick(all));
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
  }
  return chars.join('');
}

router.post('/:id/password-reset', (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: '仅演示管理员 demo 可重置密码' });
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: '用户编号不正确' });
  const db = getDatabase();
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND COALESCE(status, 'active') <> 'deleted'").get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.username === (process.env.DEMO_ADMIN_USERNAME || 'demo')) return res.status(400).json({ error: '不能通过该流程重置演示管理员 demo' });
  const request = db.prepare("SELECT * FROM password_reset_requests WHERE target_user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(userId);
  if (!request) return res.status(409).json({ error: '该账号没有待处理的重置申请' });

  const temporaryPassword = generateTemporaryPassword();
  try {
    db.transaction(() => {
      db.prepare(`UPDATE users SET password_hash = ?, password_reset_required = 1,
        token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        bcrypt.hashSync(temporaryPassword, 10), userId
      );
      const processed = db.prepare(`UPDATE password_reset_requests SET status = 'completed', processed_at = CURRENT_TIMESTAMP,
        processed_by_user_id = ?, processed_ip = ? WHERE id = ? AND status = 'pending'`).run(req.user.id, req.ip || '', request.id);
      if (processed.changes !== 1) {
        const error = new Error('该重置申请已被其他管理员处理');
        error.code = 'PASSWORD_RESET_ALREADY_PROCESSED';
        throw error;
      }
      logAccountEvent(db, req, 'user_account.password_reset', userId, { requestId: request.id });
    })();
  } catch (error) {
    if (error.code === 'PASSWORD_RESET_ALREADY_PROCESSED') return res.status(409).json({ error: error.message });
    throw error;
  }
  res.json({ message: '密码重置成功', temporaryPassword });
});

router.post('/', (req, res) => {
  const db = getDatabase();
  const username = normalizeText(req.body?.username, 50);
  const password = String(req.body?.password || '');
  const displayName = normalizeText(req.body?.display_name || username, 100) || username;
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  if (role === 'admin' && !isSuperAdmin(req)) {
    return res.status(403).json({ error: '仅超级管理员可创建管理员账号' });
  }
  const phone = normalizeText(req.body?.phone, 20);
  const passwordHint = normalizeText(req.body?.password_hint, 80);

  if (username.length < 2) return res.status(400).json({ error: '用户名至少需要2个字符' });
  if (password.length < 8) return res.status(400).json({ error: '密码长度至少为8位' });
  const passwordCategories = [
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (passwordCategories < 2) return res.status(400).json({ error: '密码需包含大写字母、小写字母、数字、特殊字符中至少两类' });
  if (passwordHint.length > 80) return res.status(400).json({ error: '密码提示不能超过80个字符' });
  if (!/^[^\s]{2,50}$/.test(username)) return res.status(400).json({ error: '用户名不能包含空格' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: '用户名已存在' });

  try {
    const result = db.transaction(() => {
      const created = db.prepare(`INSERT INTO users
        (username, password_hash, phone, display_name, role, password_hint, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')`).run(
        username, bcrypt.hashSync(password, 10), phone || null, displayName, role, passwordHint || null
      );
      syncTeamMembership(db, created.lastInsertRowid, role, 'active');
      logAccountEvent(db, req, 'user_account.created', created.lastInsertRowid, { username, role });
      return created.lastInsertRowid;
    })();
    const row = db.prepare(`SELECT u.*, tm.role team_role FROM users u
      LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = (SELECT id FROM teams WHERE code = ? LIMIT 1)
      WHERE u.id = ?`).get(DEFAULT_TEAM_CODE, result);
    res.status(201).json({ user: serializeUser(row) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: '用户名已存在' });
    throw error;
  }
});

router.patch('/:id', (req, res) => {
  const db = getDatabase();
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: '用户编号不正确' });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user || user.status === 'deleted') return res.status(404).json({ error: '用户不存在' });

  const nextStatus = req.body?.status === undefined ? (user.status || 'active') : String(req.body.status);
  const nextRole = req.body?.role === undefined ? user.role : (req.body.role === 'admin' ? 'admin' : 'user');
  if (!['active', 'disabled'].includes(nextStatus)) return res.status(400).json({ error: '账号状态不正确' });
  if (!['user', 'admin'].includes(nextRole)) return res.status(400).json({ error: '账号角色不正确' });
  if (userId === req.user.id && (nextStatus !== 'active' || nextRole !== 'admin')) return res.status(400).json({ error: '不能停用或降级当前登录的管理员账号' });
  // 操作涉及管理员账号时仅超级管理员可执行
  const targetIsAdmin = user.role === 'admin';
  const changingRoleToAdmin = nextRole === 'admin' && user.role !== 'admin';
  if ((targetIsAdmin || changingRoleToAdmin) && !isSuperAdmin(req)) {
    return res.status(403).json({ error: '仅超级管理员可修改管理员账号' });
  }

  if ((user.role === 'admin' && nextRole !== 'admin' || nextStatus !== 'active') && (user.role === 'admin' || nextRole === 'admin') && activeAdminCount(db) <= 1) {
    return res.status(400).json({ error: '系统至少需要保留一名有效的系统管理员' });
  }

  const displayName = req.body?.display_name === undefined ? user.display_name : normalizeText(req.body.display_name, 100);
  const phone = req.body?.phone === undefined ? user.phone : normalizeText(req.body.phone, 20);
  const passwordHint = req.body?.password_hint === undefined ? user.password_hint : normalizeText(req.body.password_hint, 80);
  const password = req.body?.password;
  if (password !== undefined) {
    if (String(password).length < 8) return res.status(400).json({ error: '密码长度至少为8位' });
    const cats = [
      /[A-Z]/.test(password),
      /[a-z]/.test(password),
      /[0-9]/.test(password),
      /[^A-Za-z0-9]/.test(password),
    ].filter(Boolean).length;
    if (cats < 2) return res.status(400).json({ error: '密码需包含大写字母、小写字母、数字、特殊字符中至少两类' });
  }

  const updatedId = db.transaction(() => {
    const passwordChanged = password !== undefined;
    db.prepare(`UPDATE users SET display_name = ?, phone = ?, role = ?, status = ?, password_hint = ?,
      password_hash = COALESCE(?, password_hash),
      password_reset_required = CASE WHEN ? THEN 0 ELSE password_reset_required END,
      token_version = CASE WHEN ? THEN token_version + 1 ELSE token_version END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      displayName || user.username, phone || null, nextRole, nextStatus, passwordHint || null,
      passwordChanged ? bcrypt.hashSync(String(password), 10) : null,
      passwordChanged ? 1 : 0, passwordChanged ? 1 : 0, userId
    );
    syncTeamMembership(db, userId, nextRole, nextStatus);
    logAccountEvent(db, req, 'user_account.updated', userId, { role: nextRole, status: nextStatus });
    return userId;
  })();
  const row = db.prepare(`SELECT u.*, tm.role team_role FROM users u
    LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = (SELECT id FROM teams WHERE code = ? LIMIT 1)
    WHERE u.id = ?`).get(DEFAULT_TEAM_CODE, updatedId);
  res.json({ user: serializeUser(row) });
});

router.delete('/:id', (req, res) => {
  const db = getDatabase();
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: '用户编号不正确' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.status === 'deleted') return res.status(404).json({ error: '用户不存在' });
  if (userId === req.user.id) return res.status(400).json({ error: '不能删除当前登录的管理员账号' });
  if (user.role === 'admin' && !isSuperAdmin(req)) {
    return res.status(403).json({ error: '仅超级管理员可删除管理员账号' });
  }
  if (user.role === 'admin' && user.status === 'active' && activeAdminCount(db) <= 1) return res.status(400).json({ error: '系统至少需要保留一名有效的系统管理员' });

  db.transaction(() => {
    // 保留历史业务数据的关联，同时让账号永久失效并从账号列表移除。
    const tombstoneUsername = `deleted_${userId}_${Date.now()}`;
    db.prepare(`UPDATE users SET username = ?, phone = NULL, display_name = '已删除用户',
      password_hash = ?, password_hint = NULL, status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      tombstoneUsername, bcrypt.hashSync(crypto.randomUUID(), 10), userId
    );
    db.prepare("UPDATE team_members SET status = 'deleted' WHERE user_id = ?").run(userId);
    logAccountEvent(db, req, 'user_account.deleted', userId, { username: user.username });
  })();
  res.json({ message: '用户账号已删除', userId });
});

module.exports = router;
