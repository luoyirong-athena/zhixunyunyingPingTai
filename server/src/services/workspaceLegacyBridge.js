'use strict';

const { createSyncEvent } = require('./syncHub');
const { normalizeWorkspaceState } = require('./workspaceState');

const TABLE_COLLECTIONS = {
  customers: 'customers',
  tasks: 'tasks',
  feedback: 'feedback',
  chat_records: 'chats',
  experiences: 'experiences',
  tags: 'tags',
  product_requests: 'productRequests'
};

function parseJson(value, fallback) {
  if (value !== null && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function ownerName(db, userId) {
  if (!userId) return '';
  const user = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(userId);
  return user?.display_name || user?.username || '';
}

function legacyId(table, value) {
  return String(value ?? '').trim();
}

function serializeLegacyRow(db, table, row) {
  if (!row) return null;
  const id = legacyId(table, row.id);
  const common = {
    id,
    created_by_user_id: row.created_by_user_id ?? row.user_id ?? null,
    createdBy: ownerName(db, row.created_by_user_id ?? row.user_id),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || row.created_at || '',
    _legacySource: table
  };
  if (table === 'customers') {
    return {
      ...common,
      name: row.name || '未命名客户',
      province: row.province || '', city: row.city || '', sales_status: row.sales_status || '新客户',
      phone: String(row.phone || ''), identity: row.identity || '', qq: String(row.qq || ''), org_name: row.org_name || '',
      wechat_nickname: row.wechat_nickname || '', wechat_id: row.wechat_id || '',
      douyin_nickname: row.douyin_nickname || '', douyin_id: row.douyin_id || '',
      douyin_followers: row.douyin_followers || '', channel_account: row.channel_account || row.video_account || '',
      official_account: row.official_account || row.public_account || '', address: row.address || '',
      remark: row.notes || row.remark || '', approval: row.approval_status || '正式',
      source: row.source || '', tags: parseJson(row.tags, []), extra_data: parseJson(row.extra_data, {}),
      statusHistory: []
    };
  }
  if (table === 'tasks') {
    return {
      ...common,
      title: row.title || '未命名任务', type: row.task_type || row.type || '自定义任务',
      customerId: row.customer_id == null ? '' : String(row.customer_id),
      feedbackId: row.feedback_id == null ? '' : String(row.feedback_id),
      description: row.description || '', status: row.status || '待处理', priority: row.priority || '低',
      dueDate: row.due_date || '', completedAt: row.completed_at || ''
    };
  }
  if (table === 'feedback') {
    return {
      ...common,
      customerId: row.customer_id == null ? '' : String(row.customer_id),
      customerName: row.customer_name || '', province: row.province || '',
      type: row.issue_type || row.type || '其他', content: row.content || '', priority: row.priority || '普通',
      assignee: row.assignee || '', dueDate: row.due_date || '', status: row.status || '待处理',
      resolvedAt: row.resolved_at || '', tags: parseJson(row.tags, [])
    };
  }
  if (table === 'chat_records') {
    return {
      ...common,
      customerId: row.customer_id == null ? '' : String(row.customer_id),
      fileName: row.file_name || '', messages: parseJson(row.messages, [])
    };
  }
  if (table === 'experiences') {
    return {
      ...common,
      title: row.title || '未命名经验', content: row.content || '', category: row.category || '',
      tags: parseJson(row.tags, [])
    };
  }
  if (table === 'tags') {
    return { ...common, name: row.name || '', color: row.color || '', category: row.category || '' };
  }
  if (table === 'product_requests') {
    return {
      ...common,
      title: row.title || '', description: row.description || '', priority: row.priority || '普通',
      status: row.status || '规划中'
    };
  }
  return { ...row, ...common };
}

function workspaceRow(db, teamId) {
  return db.prepare('SELECT * FROM workspace_states WHERE team_id = ?').get(teamId);
}

function readState(row) {
  return normalizeWorkspaceState(parseJson(row?.state_json, {}));
}

function writeWorkspace(db, req, previousRow, nextState, patch, source) {
  const nextVersion = Number(previousRow?.version || 0) + 1;
  db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?,
    initialized_by_user_id = COALESCE(initialized_by_user_id, ?), updated_by_user_id = ?,
    updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
    .run(JSON.stringify(nextState), nextVersion, req.user.id, req.user.id, req.team.id);
  return createSyncEvent(db, {
    teamId: req.team.id,
    entityType: 'workspace',
    entityId: String(req.team.id),
    action: 'workspace.updated',
    entityVersion: nextVersion,
    operatorUserId: req.user.id,
    requestId: `${String(req.get?.('X-Request-Id') || req.body?.requestId || `legacy-${Date.now()}`).slice(0, 120)}:workspace`,
    payload: { source, patch }
  });
}

function updateWorkspaceState(db, req, update, source = 'workspace_config') {
  const previousRow = workspaceRow(db, req.team.id);
  const previousState = readState(previousRow);
  const result = update(previousState) || {};
  const nextState = normalizeWorkspaceState(result.state || previousState);
  const event = writeWorkspace(
    db,
    req,
    previousRow,
    nextState,
    result.patch || { replace: {}, arrays: {} },
    source
  );
  return { event, state: nextState, version: event.entityVersion };
}

function mirrorLegacyEntity(db, req, { table, row = null, removeId = null }) {
  const collection = TABLE_COLLECTIONS[table];
  if (!collection) throw new Error(`Unsupported legacy workspace table: ${table}`);
  const previousRow = workspaceRow(db, req.team.id);
  const previousState = readState(previousRow);
  const list = Array.isArray(previousState[collection]) ? previousState[collection] : [];
  const id = legacyId(table, removeId ?? row?.id);
  if (!id) return null;
  const index = list.findIndex(item => String(item?.id ?? '') === id);
  let nextList;
  let change;
  if (removeId !== null && removeId !== undefined) {
    if (index < 0) return null;
    nextList = list.filter((_, itemIndex) => itemIndex !== index);
    change = { remove: [{ id, deletedAt: new Date().toISOString() }] };
  } else {
    const item = serializeLegacyRow(db, table, row);
    if (!item) return null;
    nextList = index >= 0 ? list.map((current, itemIndex) => itemIndex === index ? item : current) : [...list, item];
    change = index >= 0 ? { update: [{ id, fields: item }] } : { add: [item] };
  }
  const nextState = normalizeWorkspaceState({ ...previousState, [collection]: nextList });
  return writeWorkspace(db, req, previousRow, nextState, { replace: {}, arrays: { [collection]: change } }, `legacy_${table}`);
}

function reconcileLegacyTables(db, req, tables) {
  const previousRow = workspaceRow(db, req.team.id);
  const previousState = readState(previousRow);
  const nextState = { ...previousState };
  const arrays = {};
  for (const table of tables) {
    const collection = TABLE_COLLECTIONS[table];
    if (!collection) continue;
    const current = Array.isArray(nextState[collection]) ? nextState[collection] : [];
    const retained = current.filter(item => item?._legacySource !== table);
    const rows = db.prepare(`SELECT * FROM ${table} WHERE team_id = ? AND deleted_at IS NULL`).all(req.team.id);
    const mirrored = rows.map(row => serializeLegacyRow(db, table, row)).filter(Boolean);
    nextState[collection] = [...retained, ...mirrored];
    arrays[collection] = { replace: nextState[collection] };
  }
  const normalized = normalizeWorkspaceState(nextState);
  return writeWorkspace(db, req, previousRow, normalized, { replace: {}, arrays }, 'legacy_data_import');
}

module.exports = {
  mirrorLegacyEntity,
  reconcileLegacyTables,
  serializeLegacyRow,
  updateWorkspaceState
};
