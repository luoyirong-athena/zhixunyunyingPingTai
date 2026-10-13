'use strict';

const express = require('express');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext } = require('../middleware/team');

const router = express.Router();
router.use(authRequired, resolveTeamContext);

const ACTION_LABELS = {
  'customer.created': '新增客户',
  'customer.updated': '编辑客户',
  'customer.deleted': '删除客户',
  'customer.approved': '客户加入客户库',
  'customer.status_changed': '变更客户销售状态',
  'customer.capture_created': '采集客户',
  'customer.capture_confirmed': '确认采集客户',
  'customer.evidence_added': '添加客户附件',
  'customer.evidence_deleted': '删除客户附件',
  'customer.priority_changed': '客户优先级变化',
  'task.created': '新增待办任务',
  'task.updated': '编辑待办任务',
  'task.completed': '完成待办任务',
  'task.reopened': '重新打开待办任务',
  'task.deleted': '删除待办任务',
  'feedback.created': '新增客户反馈',
  'feedback.updated': '编辑客户反馈',
  'feedback.status_changed': '变更反馈状态',
  'feedback.deleted': '删除客户反馈',
  'chat_record.created': '导入聊天记录',
  'chat_record.deleted': '删除聊天记录',
  'knowledge.created': '新增经验内容',
  'knowledge.updated': '编辑经验内容',
  'knowledge.deleted': '删除经验内容',
  'knowledge.relations_updated': '更新经验关联',
  'knowledge.relation_deleted': '删除经验关联',
  'priority_config.updated': '更新评估分值配置',
  'settings.updated': '更新系统设置',
  'workspace.initialized': '初始化团队数据',
  'workspace.updated': '同步团队数据',
  'workspace.import.completed': '导入团队数据',
  'workspace.business_data_cleared': '清空业务数据',
  'workspace.full_backup_restored': '恢复完整备份'
};

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return value; }
}

function recordName(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return String(value.name || value.title || value.customer_name || value.file_name || '').trim();
}

function detailFor(row, before, after) {
  const name = recordName(after) || recordName(before);
  if (name) return name;
  const entity = String(row.entity_type || '').trim();
  const id = String(row.entity_id || '').trim();
  return [entity, id ? `#${id}` : ''].filter(Boolean).join(' ') || '团队数据';
}

router.get('/', (req, res) => {
  const db = getDatabase();
  const scope = String(req.query.scope || 'all') === 'mine' ? 'mine' : 'all';
  const customerQuery = String(req.query.customer_query || '').trim().slice(0, 100);
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 30));
  const page = Math.max(1, Number(req.query.page) || 1);
  const where = ['l.team_id = ?'];
  const params = [req.team.id];
  if (scope === 'mine') {
    where.push('l.operator_user_id = ?');
    params.push(req.user.id);
  }
  if (customerQuery) {
    const search = `%${customerQuery}%`;
    where.push(`(l.entity_type = 'customer' AND (
      l.entity_id LIKE ? OR l.before_data LIKE ? OR l.after_data LIKE ?
    ))`);
    params.push(search, search, search);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = Number(db.prepare(`SELECT COUNT(*) count FROM operation_logs l ${clause}`).get(...params).count || 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, totalPages);
  const rows = db.prepare(`SELECT l.*, u.display_name, u.username
    FROM operation_logs l
    LEFT JOIN users u ON u.id = l.operator_user_id
    ${clause}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ? OFFSET ?`).all(...params, limit, (currentPage - 1) * limit);
  const data = rows.map(row => {
    const before = parseJson(row.before_data);
    const after = parseJson(row.after_data);
    return {
      id: row.id,
      action: row.action,
      actionLabel: ACTION_LABELS[row.action] || row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before,
      after,
      requestId: row.request_id || '',
      ipAddress: row.ip_address || '',
      userAgent: row.user_agent || '',
      userId: row.operator_user_id,
      user: row.display_name || row.username || '系统',
      username: row.username || '',
      detail: detailFor(row, before, after),
      at: row.created_at
    };
  });
  res.json({ data, total, page: currentPage, limit, totalPages, scope, customerQuery });
});

module.exports = router;
