const express = require('express');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { requestId, recordChange, publishEvents } = require('../services/teamEvents');
const { canWriteCustomer, resolveCustomerOwnerId } = require('../services/dataPermissions');
const { mirrorLegacyEntity, reconcileLegacyTables } = require('../services/workspaceLegacyBridge');

const router = express.Router();
router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);

const DEFAULT_STATUS_NAMES = ['新客户', '已联系', '已加微信', '已电联', '已抖音私信', '高意向', '试用中', '已付费', '待维护', '已流失'];
const safeJson = (value, fallback) => { if (value !== null && typeof value === 'object') return value; try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; } };
const jsonText = (value, fallback) => JSON.stringify(safeJson(value, fallback));
const normalizeProvince = (value) => String(value || '').trim().replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/, '');

function allowedStatuses(db, teamId) {
  const names = db.prepare("SELECT DISTINCT name FROM sales_statuses WHERE team_id = ? AND is_enabled = 1 AND deleted_at IS NULL").all(teamId).map((row) => row.name);
  return new Set(names.length ? names : DEFAULT_STATUS_NAMES);
}

function serialize(row) {
  if (!row) return row;
  const channelAccount = row.channel_account || row.video_account || '';
  const officialAccount = row.official_account || row.public_account || '';
  return { ...row, channel_account: channelAccount, official_account: officialAccount, video_account: row.video_account || channelAccount, public_account: row.public_account || officialAccount, remark: row.notes || '', tags: safeJson(row.tags, []), extra_data: safeJson(row.extra_data, {}) };
}

function customerValues(body = {}, existing = {}) {
  const value = (key, fallback = '') => body[key] !== undefined ? body[key] : (existing[key] !== undefined ? existing[key] : fallback);
  const channelAccount = body.channel_account !== undefined ? body.channel_account : (body.video_account !== undefined ? body.video_account : (existing.channel_account || existing.video_account || ''));
  const officialAccount = body.official_account !== undefined ? body.official_account : (body.public_account !== undefined ? body.public_account : (existing.official_account || existing.public_account || ''));
  const notes = body.notes !== undefined ? body.notes : (body.remark !== undefined ? body.remark : (existing.notes || ''));
  return {
    name: String(value('name')).trim(), province: normalizeProvince(value('province')), sales_status: String(value('sales_status', '新客户') || '新客户').trim(),
    phone: String(value('phone')), identity: String(value('identity')), qq: String(value('qq', value('qq_number', ''))), org_name: String(value('org_name')), wechat_nickname: String(value('wechat_nickname')),
    wechat_id: String(value('wechat_id')), douyin_nickname: String(value('douyin_nickname')), douyin_id: String(value('douyin_id')),
    douyin_followers: String(value('douyin_followers', '') ?? '').trim(), channel_account: String(channelAccount || ''), official_account: String(officialAccount || ''), address: String(value('address', value('customer_address', '')) || ''),
    city: String(value('city')), notes: String(notes || ''), approval_status: String(value('approval_status', '正式') || '正式'), source: String(value('source')),
    level: String(value('level', '潜在客户') || '潜在客户'), status: String(value('status', '新线索') || '新线索'),
    tags: jsonText(body.tags !== undefined ? body.tags : existing.tags, []), extra_data: jsonText(body.extra_data !== undefined ? body.extra_data : existing.extra_data, {})
  };
}

function insertCustomer(db, req, customer) {
  return db.prepare(`INSERT INTO customers (
    user_id, team_id, created_by_user_id, updated_by_user_id, version,
    name, province, sales_status, phone, identity, qq, org_name, wechat_nickname, wechat_id,
    douyin_nickname, douyin_id, douyin_followers, channel_account, official_account, address, video_account, public_account,
    city, notes, approval_status, source, level, status, tags, extra_data
  ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, req.team.id, req.user.id, req.user.id,
      customer.name, customer.province, customer.sales_status, customer.phone, customer.identity, customer.qq, customer.org_name,
      customer.wechat_nickname, customer.wechat_id, customer.douyin_nickname, customer.douyin_id, customer.douyin_followers,
      customer.channel_account, customer.official_account, customer.address, customer.channel_account, customer.official_account, customer.city,
      customer.notes, customer.approval_status, customer.source, customer.level, customer.status, customer.tags, customer.extra_data);
}

function addStatusHistory(db, req, customerId, fromStatus, toStatus, reason, rid, events, version) {
  const statusEvent = recordChange(db, req, { entityType: 'customer', entityId: customerId, action: 'customer.status_changed', version, before: { sales_status: fromStatus }, after: { sales_status: toStatus }, payload: { customerId, fromStatus, toStatus, reason }, requestId: rid });
  db.prepare(`INSERT INTO customer_status_history
    (user_id, team_id, created_by_user_id, updated_by_user_id, customer_id, operator_user_id, from_status, to_status, reason, source, request_id, sync_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', ?, ?)`)
    .run(req.user.id, req.team.id, req.user.id, req.user.id, customerId, req.user.id, fromStatus || '', toStatus || '', reason || '', rid, statusEvent.eventId);
  events.push(statusEvent);
}

router.get('/stats', (req, res) => {
  const db = getDatabase(); const teamId = req.team.id;
  const active = 'team_id = ? AND deleted_at IS NULL';
  const total = db.prepare(`SELECT COUNT(*) count FROM customers WHERE ${active} AND approval_status != '待确认'`).get(teamId).count;
  const pending = db.prepare(`SELECT COUNT(*) count FROM customers WHERE ${active} AND approval_status = '待确认'`).get(teamId).count;
  const bySalesStatus = db.prepare(`SELECT sales_status name, COUNT(*) count FROM customers WHERE ${active} AND approval_status != '待确认' GROUP BY sales_status ORDER BY count DESC`).all(teamId);
  const byProvince = db.prepare(`SELECT province name, COUNT(*) count FROM customers WHERE ${active} AND approval_status != '待确认' GROUP BY province ORDER BY count DESC`).all(teamId);
  const todayNew = db.prepare(`SELECT COUNT(*) count FROM customers WHERE ${active} AND date(created_at) = date('now', 'localtime')`).get(teamId).count;
  res.json({ total, pending, todayNew, bySalesStatus, byProvince });
});

router.post('/batch', (req, res) => {
  const db = getDatabase(); const customers = Array.isArray(req.body.customers) ? req.body.customers : [];
  if (!customers.length) return res.status(400).json({ error: '请提供客户数据数组' });
  const errors = []; const statuses = allowedStatuses(db, req.team.id);
  customers.forEach((item, index) => { const salesStatus = String(item.sales_status || '').trim(); if (!String(item.name || '').trim()) errors.push({ row: index + 2, field: '姓名', message: '姓名不能为空' }); if (!String(item.province || '').trim()) errors.push({ row: index + 2, field: '省份', message: '省份不能为空' }); if (!salesStatus) errors.push({ row: index + 2, field: '销售状态', message: '销售状态不能为空' }); else if (!statuses.has(salesStatus)) errors.push({ row: index + 2, field: '销售状态', message: `销售状态“${salesStatus}”未在系统中配置` }); });
  if (errors.length) return res.status(400).json({ error: '导入数据校验失败', errors });
  const events = [];
  const ids = db.transaction((items) => {
    const importedIds = items.map((item, index) => {
      const customer = customerValues({ ...item, approval_status: item.approval_status || '待确认' });
      const id = Number(insertCustomer(db, req, customer).lastInsertRowid); const rid = requestId(req, `customer-${index}-${id}`);
      const row = serialize(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
      events.push(recordChange(db, req, { entityType: 'customer', entityId: id, action: 'customer.created', version: 1, after: row, payload: { customerId: id }, requestId: rid }));
      addStatusHistory(db, req, id, '', customer.sales_status, '批量导入客户', `${rid}:status`, events, 1);
      return id;
    });
    events.push(reconcileLegacyTables(db, req, ['customers']));
    return importedIds;
  })(customers);
  publishEvents(req.team.id, events); res.status(201).json({ message: `成功导入 ${ids.length} 条客户数据`, count: ids.length, ids });
});

router.get('/', (req, res) => {
  const db = getDatabase(); const { page = 1, limit = 20, sales_status, approval_status, province, city, identity, search, sort = 'updated_at', order = 'DESC' } = req.query;
  const where = ['team_id = ?', 'deleted_at IS NULL']; const params = [req.team.id];
  if (sales_status) { const values = sales_status.split(',').filter(Boolean); if (values.length) { where.push(`sales_status IN (${values.map(() => '?').join(',')})`); params.push(...values); } }
  if (approval_status) { where.push('approval_status = ?'); params.push(approval_status); } if (province) { where.push('province = ?'); params.push(normalizeProvince(province)); }
  if (city) { where.push('city = ?'); params.push(city); } if (identity) { where.push('identity = ?'); params.push(identity); }
  if (search) { const term = `%${search}%`; where.push(`(name LIKE ? OR phone LIKE ? OR wechat_id LIKE ? OR qq LIKE ? OR wechat_nickname LIKE ? OR douyin_nickname LIKE ? OR douyin_id LIKE ? OR channel_account LIKE ? OR official_account LIKE ? OR video_account LIKE ? OR public_account LIKE ? OR address LIKE ? OR org_name LIKE ? OR city LIKE ? OR notes LIKE ?)`); params.push(...Array(15).fill(term)); }
  const allowedSort = ['name', 'sales_status', 'created_at', 'updated_at', 'province', 'city']; const sortCol = allowedSort.includes(sort) ? sort : 'updated_at'; const sortOrder = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const pageNumber = Math.max(1, Number(page) || 1); const pageSize = Math.min(200, Math.max(1, Number(limit) || 20)); const offset = (pageNumber - 1) * pageSize; const clause = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) count FROM customers ${clause}`).get(...params).count;
  const rows = db.prepare(`SELECT * FROM customers ${clause} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  res.json({ data: rows.map(serialize), total, page: pageNumber, limit: pageSize });
});

router.get('/:id', (req, res) => {
  const db = getDatabase(); const row = db.prepare('SELECT * FROM customers WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(req.params.id, req.team.id);
  if (!row) return res.status(404).json({ error: '客户不存在' });
  const statusHistory = db.prepare('SELECT h.*, u.display_name operator_display_name, u.username operator_username FROM customer_status_history h LEFT JOIN users u ON u.id=h.operator_user_id WHERE h.customer_id = ? AND h.team_id = ? AND h.deleted_at IS NULL ORDER BY h.created_at DESC').all(req.params.id, req.team.id);
  res.json({ ...serialize(row), status_history: statusHistory });
});

router.post('/', (req, res) => {
  const db = getDatabase(); const customer = customerValues(req.body);
  if (!customer.name) return res.status(400).json({ error: '客户姓名不能为空' }); if (customer.phone && !/^1[3-9]\d{9}$/.test(customer.phone.replace(/\s+/g, ''))) return res.status(400).json({ error: '手机号格式不正确' }); if (!customer.province) return res.status(400).json({ error: '省份不能为空' }); if (!allowedStatuses(db, req.team.id).has(customer.sales_status)) return res.status(400).json({ error: `销售状态“${customer.sales_status}”未在系统中配置` });
  const events = []; let row;
  db.transaction(() => { const id = Number(insertCustomer(db, req, customer).lastInsertRowid); row = serialize(db.prepare('SELECT * FROM customers WHERE id = ?').get(id)); const rid = requestId(req); events.push(recordChange(db, req, { entityType: 'customer', entityId: id, action: 'customer.created', version: 1, after: row, payload: { customerId: id }, requestId: rid })); addStatusHistory(db, req, id, '', customer.sales_status, '新增客户', `${rid}:status`, events, 1); events.push(mirrorLegacyEntity(db, req, { table: 'customers', row })); })();
  publishEvents(req.team.id, events); res.status(201).json(row);
});

router.put('/:id', (req, res) => {
  const db = getDatabase(); const existing = db.prepare('SELECT * FROM customers WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(req.params.id, req.team.id);
  if (!existing) return res.status(404).json({ error: '客户不存在' });
  if (!canWriteCustomer(db, req, existing)) return res.status(403).json({
    error: '您没有编辑该客户的权限，请先向创建人申请',
    code: 'CUSTOMER_PERMISSION_REQUIRED', customerId: String(existing.id), customerName: existing.name || '',
    ownerUserId: resolveCustomerOwnerId(db, req.team.id, existing) || null
  });
  const customer = customerValues(req.body, existing);
  if (!customer.name || !customer.province || !customer.sales_status) return res.status(400).json({ error: '姓名、省份和销售状态不能为空' }); if (customer.phone && !/^1[3-9]\d{9}$/.test(customer.phone.replace(/\s+/g, ''))) return res.status(400).json({ error: '手机号格式不正确' }); if (!allowedStatuses(db, req.team.id).has(customer.sales_status)) return res.status(400).json({ error: `销售状态“${customer.sales_status}”未在系统中配置` });
  const events = []; let updated;
  db.transaction(() => {
    db.prepare(`UPDATE customers SET name=?, province=?, sales_status=?, phone=?, identity=?, qq=?, org_name=?, wechat_nickname=?, wechat_id=?, douyin_nickname=?, douyin_id=?, douyin_followers=?, channel_account=?, official_account=?, address=?, video_account=?, public_account=?, city=?, notes=?, approval_status=?, source=?, level=?, status=?, tags=?, extra_data=?, updated_by_user_id=?, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND team_id=? AND deleted_at IS NULL`)
      .run(customer.name, customer.province, customer.sales_status, customer.phone, customer.identity, customer.qq, customer.org_name, customer.wechat_nickname, customer.wechat_id, customer.douyin_nickname, customer.douyin_id, customer.douyin_followers, customer.channel_account, customer.official_account, customer.address, customer.channel_account, customer.official_account, customer.city, customer.notes, customer.approval_status, customer.source, customer.level, customer.status, customer.tags, customer.extra_data, req.user.id, req.params.id, req.team.id);
    updated = serialize(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id)); const rid = requestId(req);
    events.push(recordChange(db, req, { entityType: 'customer', entityId: req.params.id, action: 'customer.updated', version: updated.version, before: serialize(existing), after: updated, payload: { customerId: Number(req.params.id) }, requestId: rid }));
    if (existing.sales_status !== customer.sales_status) addStatusHistory(db, req, Number(req.params.id), existing.sales_status || '', customer.sales_status, req.body.status_reason || '编辑客户资料', `${rid}:status`, events, updated.version);
    events.push(mirrorLegacyEntity(db, req, { table: 'customers', row: updated }));
  })();
  publishEvents(req.team.id, events); res.json(updated);
});

router.delete('/:id', (req, res) => {
  const db = getDatabase(); const existing = db.prepare('SELECT * FROM customers WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(req.params.id, req.team.id);
  if (!existing) return res.status(404).json({ error: '客户不存在' });
  if (!canWriteCustomer(db, req, existing)) return res.status(403).json({
    error: '您没有删除该客户的权限，请先向创建人申请',
    code: 'CUSTOMER_PERMISSION_REQUIRED', customerId: String(existing.id), customerName: existing.name || '',
    ownerUserId: resolveCustomerOwnerId(db, req.team.id, existing) || null
  });
  const events = [];
  db.transaction(() => { db.prepare('UPDATE customers SET deleted_at=CURRENT_TIMESTAMP, deleted_by_user_id=?, updated_by_user_id=?, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND team_id=? AND deleted_at IS NULL').run(req.user.id, req.user.id, req.params.id, req.team.id); const row = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id); events.push(recordChange(db, req, { entityType: 'customer', entityId: req.params.id, action: 'customer.deleted', version: row.version, before: serialize(existing), after: { deleted_at: row.deleted_at }, payload: { customerId: Number(req.params.id) } })); const workspaceEvent = mirrorLegacyEntity(db, req, { table: 'customers', removeId: req.params.id }); if (workspaceEvent) events.push(workspaceEvent); })();
  publishEvents(req.team.id, events); res.json({ message: '删除成功' });
});

module.exports = router;
