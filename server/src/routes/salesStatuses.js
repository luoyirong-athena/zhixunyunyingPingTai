const express = require('express');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { recordChange, publishEvents, requestId } = require('../services/teamEvents');
const { workspaceCollections } = require('../services/workspaceReadModel');
const { updateWorkspaceState } = require('../services/workspaceLegacyBridge');
const { getPriorityConfig, savePriorityConfig } = require('../services/priorityCustomers');

const router = express.Router();
router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);

const DEFAULTS = [
  ['新客户', '#315efb', 0, 0, 1, 20, 0],
  ['已联系', '#0891b2', 1, 1, 1, 15, 0],
  ['已加微信', '#7c3aed', 2, 1, 1, 20, 0],
  ['已电联', '#f59e0b', 3, 0, 1, 10, 0],
  ['已抖音私信', '#ec4899', 4, 0, 1, 15, 0],
  ['高意向', '#f59e0b', 5, 1, 1, 30, 0],
  ['试用中', '#7c3aed', 6, 1, 1, 20, 0],
  ['已付费', '#19a974', 7, 1, 1, 0, 1],
  ['待维护', '#14b8a6', 8, 0, 1, 10, 0],
  ['已流失', '#ef4444', 9, 0, 1, 0, 1]
];

function defaultPriority(name) {
  const item = DEFAULTS.find(entry => entry[0] === name);
  return item ? { enabled: item[4], score: item[5], excluded: item[6] } : { enabled: 1, score: 10, excluded: 0 };
}

function active(db, teamId) {
  return db.prepare(`SELECT MIN(id) id, name, MAX(color) color, MIN(sort_order) sort_order,
      MAX(is_funnel) is_funnel, MAX(priority_enabled) priority_enabled,
      MAX(priority_score) priority_score, MAX(priority_excluded) priority_excluded,
      1 is_enabled, MAX(version) version
    FROM sales_statuses
    WHERE team_id = ? AND deleted_at IS NULL AND is_enabled = 1
    GROUP BY name ORDER BY sort_order, id`).all(teamId);
}

function ensureDefaults(db, req) {
  const count = db.prepare(`SELECT COUNT(*) count FROM sales_statuses
    WHERE team_id = ? AND deleted_at IS NULL AND is_enabled = 1`).get(req.team.id).count;
  if (count) return;
  const insert = db.prepare(`INSERT OR IGNORE INTO sales_statuses
    (user_id, team_id, created_by_user_id, updated_by_user_id, version, name, color, sort_order,
     is_funnel, is_enabled, priority_enabled, priority_score, priority_excluded)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => DEFAULTS.forEach(([name, color, sort, funnel, enabled, score, excluded]) =>
    insert.run(req.user.id, req.team.id, req.user.id, req.user.id, name, color, sort, funnel, enabled, 1, score, excluded)))();
}

router.get('/', (req, res) => {
  const db = getDatabase();
  ensureDefaults(db, req);
  res.json(active(db, req.team.id));
});

router.put('/', (req, res) => {
  const db = getDatabase();
  const requestedStatuses = Array.isArray(req.body.statuses) ? req.body.statuses : [];
  if (!requestedStatuses.length) return res.status(400).json({ error: '至少保留一个销售状态' });
  const names = new Set();
  for (const status of requestedStatuses) {
    const name = String(status.name || '').trim();
    if (!name) return res.status(400).json({ error: '销售状态名称不能为空' });
    if (names.has(name)) return res.status(400).json({ error: `销售状态“${name}”重复` });
    names.add(name);
  }
  const collections = workspaceCollections(db, req.team.id);
  const previousStatuses = collections.statuses;
  const previousById = new Map(previousStatuses.map(status => [String(status?.id ?? ''), status]));
  const renameMap = new Map();
  requestedStatuses.forEach(status => {
    const previous = previousById.get(String(status?.id ?? ''));
    const nextName = String(status.name || '').trim();
    if (previous?.name && previous.name !== nextName) renameMap.set(previous.name, nextName);
  });
  const used = collections.customers.reduce((map, customer) => {
    const status = String(customer?.sales_status || customer?.salesStatus || '').trim();
    if (status) map.set(status, (map.get(status) || 0) + 1);
    return map;
  }, new Map());
  const removed = [...used.entries()]
    .filter(([name, count]) => !names.has(renameMap.get(name) || name) && count > 0)
    .map(([sales_status, count]) => ({ sales_status, count }));
  if (removed.length) return res.status(409).json({ error: '以下状态仍有客户使用，不能删除', statuses: removed });

  const priorityConfig = req.body.priorityConfig || getPriorityConfig(db, req.team.id);
  const requestedWeights = priorityConfig.weights || {};
  const weightTotal = ['followers', 'evidence', 'status']
    .reduce((sum, key) => sum + (Number(requestedWeights[key]) || 0), 0);
  if (weightTotal !== 100) return res.status(400).json({ error: `三大维度分值占比合计必须为100%，当前为 ${weightTotal}%` });

  const before = active(db, req.team.id);
  const priorityBefore = getPriorityConfig(db, req.team.id);
  const events = [];
  let after, savedPriority;
  db.transaction(() => {
    for (const [oldName, newName] of renameMap) {
      db.prepare(`UPDATE customers SET sales_status = ?, updated_by_user_id = ?, version = version + 1,
        updated_at = CURRENT_TIMESTAMP WHERE team_id = ? AND deleted_at IS NULL AND sales_status = ?`)
        .run(newName, req.user.id, req.team.id, oldName);
    }
    db.prepare(`UPDATE sales_statuses SET deleted_at = CURRENT_TIMESTAMP, deleted_by_user_id = ?,
      updated_by_user_id = ?, version = version + 1 WHERE team_id = ? AND deleted_at IS NULL`)
      .run(req.user.id, req.user.id, req.team.id);
    const find = db.prepare('SELECT * FROM sales_statuses WHERE team_id = ? AND name = ? ORDER BY id LIMIT 1');
    const revive = db.prepare(`UPDATE sales_statuses SET team_id = ?, color = ?, sort_order = ?, is_funnel = ?,
      is_enabled = 1, priority_enabled = ?, priority_score = ?, priority_excluded = ?, deleted_at = NULL,
      deleted_by_user_id = NULL, updated_by_user_id = ?, version = version + 1 WHERE id = ?`);
    const insert = db.prepare(`INSERT INTO sales_statuses
      (user_id, team_id, created_by_user_id, updated_by_user_id, version, name, color, sort_order, is_funnel,
       is_enabled, priority_enabled, priority_score, priority_excluded)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, ?)`);
    requestedStatuses.forEach((status, index) => {
      const name = String(status.name).trim();
      const existing = find.get(req.team.id, name);
      const fallback = defaultPriority(name);
      const enabled = status.priority_enabled == null ? Number(existing?.priority_enabled ?? fallback.enabled) : (status.priority_enabled ? 1 : 0);
      const score = Math.max(0, Math.min(100, Number(status.priority_score ?? existing?.priority_score ?? fallback.score) || 0));
      const excluded = status.priority_excluded == null ? Number(existing?.priority_excluded ?? fallback.excluded) : (status.priority_excluded ? 1 : 0);
      if (existing) {
        revive.run(req.team.id, status.color || existing.color || '#315efb', index,
          status.is_funnel || status.funnel ? 1 : 0, enabled, score, excluded, req.user.id, existing.id);
      } else {
        insert.run(req.user.id, req.team.id, req.user.id, req.user.id, name, status.color || '#315efb', index,
          status.is_funnel || status.funnel ? 1 : 0, enabled, score, excluded);
      }
    });
    after = active(db, req.team.id);
    savedPriority = savePriorityConfig(db, req.team.id, priorityConfig);
    const normalizedStatuses = requestedStatuses.map((status, index) => {
      const name = String(status.name).trim();
      const configured = after.find(item => item.name === name);
      return {
        ...status,
        id: status.id || previousStatuses.find(item => item?.name === name)?.id || `status-${Date.now()}-${index}`,
        name,
        color: configured?.color || status.color || '#315efb',
        sort_order: index,
        priority_enabled: Number(configured?.priority_enabled ?? status.priority_enabled) === 1 ? 1 : 0,
        priority_score: Number(configured?.priority_score ?? status.priority_score ?? 0),
        priority_excluded: Number(configured?.priority_excluded ?? status.priority_excluded) === 1 ? 1 : 0
      };
    });
    const priorityAfter = after.map(item => ({
      name: item.name,
      priority_enabled: Number(item.priority_enabled) === 1,
      priority_score: Number(item.priority_score || 0),
      priority_excluded: Number(item.priority_excluded) === 1
    }));
    const workspace = updateWorkspaceState(db, req, previousState => {
      const customerUpdates = [];
      const customers = (Array.isArray(previousState.customers) ? previousState.customers : []).map(customer => {
        const currentName = String(customer?.sales_status || customer?.salesStatus || '').trim();
        const renamed = renameMap.get(currentName);
        if (!renamed) return customer;
        const updatedAt = new Date().toISOString();
        customerUpdates.push({ id: customer.id, fields: { sales_status: renamed, updatedAt } });
        return { ...customer, sales_status: renamed, updatedAt };
      });
      const settings = { ...(previousState.settings || {}), priorityConfig: savedPriority };
      return {
        state: { ...previousState, statuses: normalizedStatuses, customers, settings },
        patch: {
          replace: { settings },
          arrays: {
            statuses: { replace: normalizedStatuses },
            ...(customerUpdates.length ? { customers: { update: customerUpdates } } : {})
          }
        }
      };
    }, 'sales_status_config');
    events.push(recordChange(db, req, {
      entityType: 'sales_status', entityId: req.team.id, action: 'settings.updated',
      version: workspace.version, before, after,
      payload: { count: after.length, priorityConfigUpdated: true }
    }));
    events.push(recordChange(db, req, {
      entityType: 'priority_config', entityId: req.team.id, action: 'priority_config.updated',
      version: workspace.version, before: priorityBefore, after: { config: savedPriority, statuses: priorityAfter },
      payload: { count: priorityAfter.length }, requestId: requestId(req, 'priority-config')
    }));
    events.push(workspace.event);
  })();
  publishEvents(req.team.id, events);
  res.json({ message: '销售状态已保存', data: after, priorityConfig: savedPriority });
});

module.exports = router;
