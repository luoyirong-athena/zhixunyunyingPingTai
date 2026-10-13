'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../config/database');
const { createSyncEvent } = require('./syncHub');

const DATA_DIR = path.resolve(process.env.ZHIXUN_DATA_DIR || path.join(__dirname, '..', '..', 'data'));
const DB_PATH = path.resolve(process.env.ZHIXUN_DB_PATH || path.join(DATA_DIR, 'zhixun.db'));
const BACKUP_DIR = path.resolve(process.env.ZHIXUN_BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const CUSTOMER_EVIDENCE_DIR = path.resolve(process.env.ZHIXUN_CUSTOMER_EVIDENCE_DIR || path.join(DATA_DIR, 'customer-evidence'));
const MATERIALS_DIR = path.resolve(process.env.ZHIXUN_MATERIALS_DIR || path.join(DATA_DIR, 'materials'));
const CONFIRMATION_TEXT = '确认清空全部业务数据';

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';
}

function removePath(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* best effort cleanup after a committed reset */ }
}

function copyPath(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(source, target, { recursive: true, errorOnExist: false, force: true });
    return true;
  }
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyPath(path.join(source, entry), path.join(target, entry));
  } else fs.copyFileSync(source, target);
  return true;
}

function fileRecordPath(row, key) {
  const value = row?.[key];
  if (!value) return null;
  const resolved = path.resolve(String(value));
  const allowedRoots = [DATA_DIR, CUSTOMER_EVIDENCE_DIR, MATERIALS_DIR]
    .map(root => path.resolve(root));
  if (allowedRoots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`))) return resolved;
  return null;
}

function customerRelatedMaterialIds(db, teamId) {
  const rows = db.prepare(`SELECT source_type, source_id, target_type, target_id
    FROM knowledge_relations WHERE team_id = ?`).all(teamId);
  const ids = new Set();
  for (const row of rows) {
    if (row.source_type === 'customer' && row.target_type === 'material') ids.add(String(row.target_id));
    if (row.target_type === 'customer' && row.source_type === 'material') ids.add(String(row.source_id));
  }
  return ids;
}

function customerRelatedMaterialRows(db, teamId) {
  const ids = customerRelatedMaterialIds(db, teamId);
  const rows = db.prepare(`SELECT * FROM materials_files WHERE team_id = ?`).all(teamId);
  return rows.filter(row => ids.has(String(row.id)) || /客户|customer/i.test(String(row.category || '')));
}

function buildClearedWorkspaceState(currentState, { operatorId, operatorName, at }) {
  // Keep the complete workspace object and only reset fields that are known to
  // contain business data. This avoids silently dropping future settings or
  // feature flags that older clients do not know about.
  const next = currentState && typeof currentState === 'object' && !Array.isArray(currentState)
    ? clone(currentState)
    : {};
  next.version = Number(next.version || 2);
  next.dataVersionName = '';
  next.customers = [];
  next.tasks = [];
  next.feedback = [];
  next.chats = [];
  next.captures = [];
  next.captureSession = {};
  next.duplicateResolutions = [];
  next.logs = Array.isArray(next.logs) ? next.logs : [];
  next.logs.unshift({
    id: `log_reset_${Date.now()}`,
    action: '清空业务数据',
    detail: '管理员已清空全部客户及其关联业务数据，经验中心内容已保留',
    at: at || new Date().toISOString(),
    userId: operatorId == null ? '' : operatorId,
    user: operatorName || '',
    username: operatorName || ''
  });
  next.logs = next.logs.slice(0, 300);
  return next;
}

function collectBusinessCounts(db, teamId) {
  const tables = [
    'customers', 'tasks', 'feedback', 'chat_records', 'customer_status_history',
    'workspace_customer_status_history', 'customer_evidence', 'customer_data_permissions',
    'product_requests', 'tags', 'knowledge_relations', 'idempotency_requests',
    'sync_queue_jobs'
  ];
  const counts = {};
  for (const table of tables) {
    try { counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE team_id = ?`).get(teamId)?.count || 0); }
    catch (_) { counts[table] = 0; }
  }
  try { counts.workspace_state = Number(db.prepare('SELECT version FROM workspace_states WHERE team_id = ?').get(teamId)?.version || 0); } catch (_) { counts.workspace_state = 0; }
  return counts;
}

async function createResetBackup({ db, teamId, userId, requestId }) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const finalDir = path.join(BACKUP_DIR, `business-reset-${stamp}-${safeName(teamId)}-${crypto.randomBytes(5).toString('hex')}`);
  const tempDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    await db.backup(path.join(tempDir, 'zhixun.db'));
    copyPath(CUSTOMER_EVIDENCE_DIR, path.join(tempDir, 'files', 'customer-evidence'));
    copyPath(MATERIALS_DIR, path.join(tempDir, 'files', 'materials'));
    const manifest = {
      version: 1,
      type: 'business-data-reset-backup',
      createdAt: new Date().toISOString(),
      teamId: Number(teamId),
      operatorUserId: Number(userId),
      requestId: String(requestId || ''),
      database: 'zhixun.db',
      includedFiles: ['files/customer-evidence', 'files/materials']
    };
    fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    fs.renameSync(tempDir, finalDir);
    return {
      directory: finalDir,
      name: path.basename(finalDir),
      relativeDirectory: path.relative(DATA_DIR, finalDir),
      manifest
    };
  } catch (error) {
    removePath(tempDir);
    throw new Error(`清空前备份失败，未修改任何业务数据：${error.message}`);
  }
}

function deleteFilesAfterCommit(paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  const failed = [];
  for (const target of unique) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(target)) failed.push(target);
    } catch (_) {
      failed.push(target);
    }
  }
  return { attempted: unique.length, failed };
}

async function resetBusinessData({ req, confirmation, requestId }) {
  if (confirmation !== CONFIRMATION_TEXT) {
    const error = new Error(`请输入完全一致的确认文字：${CONFIRMATION_TEXT}`);
    error.statusCode = 400;
    throw error;
  }
  const db = getDatabase();
  const teamId = req.team.id;
  const rid = String(requestId || `business-reset-${Date.now()}`).slice(0, 100);
  const cached = db.prepare('SELECT response_json FROM idempotency_requests WHERE team_id = ? AND request_id = ?').get(teamId, rid);
  if (cached?.response_json) return { ...parseJson(cached.response_json, {}), idempotent: true };

  const backup = await createResetBackup({ db, teamId, userId: req.user.id, requestId: rid });
  const evidenceFiles = db.prepare('SELECT file_path FROM customer_evidence WHERE team_id = ?').all(teamId)
    .map(row => fileRecordPath(row, 'file_path')).filter(Boolean);
  const materialRows = customerRelatedMaterialRows(db, teamId);
  const materialFiles = materialRows.map(row => fileRecordPath(row, 'storage_path')).filter(Boolean);
  const before = collectBusinessCounts(db, teamId);
  const stateRow = db.prepare('SELECT state_json, version FROM workspace_states WHERE team_id = ?').get(teamId);
  const currentState = parseJson(stateRow?.state_json, {});
  const clearedState = buildClearedWorkspaceState(currentState, {
    operatorId: req.user.id,
    operatorName: req.user.display_name || req.user.username,
    at: new Date().toISOString()
  });
  const events = [];
  let response;

  db.transaction(() => {
    // Remove child rows first. These are hard-deleted intentionally so deleted
    // customers cannot leave behind chats, permissions, evidence, or caches.
    for (const table of ['tasks', 'chat_records', 'feedback', 'customer_status_history', 'workspace_customer_status_history', 'customer_data_permissions', 'customer_evidence']) {
      db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).run(teamId);
    }
    db.prepare(`DELETE FROM knowledge_relations WHERE team_id = ?
      AND ((source_type = 'customer') OR (target_type = 'customer'))`).run(teamId);
    if (materialRows.length) {
      const placeholders = materialRows.map(() => '?').join(',');
      const ids = materialRows.map(row => row.id);
      db.prepare(`DELETE FROM materials_jobs WHERE team_id = ? AND material_id IN (${placeholders})`).run(teamId, ...ids);
      db.prepare(`DELETE FROM materials_files WHERE team_id = ? AND id IN (${placeholders})`).run(teamId, ...ids);
    }
    // Customer labels are part of the customer workspace. Product requests are
    // independent planning records and are intentionally retained.
    for (const table of ['customers', 'tags']) db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).run(teamId);
    // Sync events and idempotency responses are caches. Keeping the reset event
    // below gives connected and polling clients a cursor newer than old data.
    db.prepare(`DELETE FROM sync_queue_batches WHERE job_id IN
      (SELECT id FROM sync_queue_jobs WHERE team_id = ? )`).run(teamId);
    db.prepare('DELETE FROM sync_queue_jobs WHERE team_id = ?').run(teamId);
    db.prepare('DELETE FROM sync_events WHERE team_id = ?').run(teamId);
    db.prepare('DELETE FROM idempotency_requests WHERE team_id = ?').run(teamId);

    const nextVersion = Number(stateRow?.version || 0) + 1;
    db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, initialized_by_user_id = COALESCE(initialized_by_user_id, ?), updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
      .run(JSON.stringify(clearedState), nextVersion, req.user.id, req.user.id, teamId);
    const event = createSyncEvent(db, {
      teamId,
      entityType: 'workspace',
      entityId: String(teamId),
      action: 'workspace.business_data_cleared',
      entityVersion: nextVersion,
      operatorUserId: req.user.id,
      requestId: rid,
      payload: { source: 'admin_reset', backupName: backup.name, backupDirectory: backup.relativeDirectory, clearedAt: new Date().toISOString() }
    });
    events.push(event);
    db.prepare(`INSERT INTO operation_logs
      (team_id, operator_user_id, entity_type, entity_id, action, before_data, after_data, request_id, ip_address, user_agent)
      VALUES (?, ?, 'workspace', ?, 'business_data_cleared', ?, ?, ?, ?, ?)`).run(
      teamId, req.user.id, String(teamId), JSON.stringify(before), JSON.stringify({
        customers: 0, tasks: 0, feedback: 0, chats: 0, captures: 0,
        customerRelatedFilesRemoved: evidenceFiles.length + materialFiles.length,
        experienceCenterPreserved: true, backupDirectory: backup.relativeDirectory
      }), rid, req.ip || '', req.get?.('user-agent') || ''
    );
    response = {
      message: '业务数据已清空，经验中心及系统配置已保留',
      requestId: rid,
      backup: { name: backup.name, directory: backup.relativeDirectory, createdAt: backup.manifest.createdAt },
      version: nextVersion,
      cleared: { customers: 0, tasks: 0, feedback: 0, chats: 0, captures: 0 }
    };
    db.prepare('INSERT INTO idempotency_requests (team_id, user_id, request_id, response_json) VALUES (?, ?, ?, ?)')
      .run(teamId, req.user.id, rid, JSON.stringify(response));
  })();

  const fileCleanup = deleteFilesAfterCommit([...evidenceFiles, ...materialFiles]);
  response.cleared.customerRelatedFilesRemoved = fileCleanup.attempted - fileCleanup.failed.length;
  response.cleared.fileCleanupFailures = fileCleanup.failed.length;
  if (fileCleanup.failed.length) {
    response.message = '业务数据已清空，但有部分客户附件未能删除，请根据备份目录处理';
  }
  // Store the final response after file cleanup so a retried request receives
  // the real cleanup result instead of the pre-cleanup success payload.
  db.prepare('UPDATE idempotency_requests SET response_json = ? WHERE team_id = ? AND request_id = ?')
    .run(JSON.stringify(response), teamId, rid);
  return { ...response, events };
}

module.exports = {
  CONFIRMATION_TEXT,
  buildClearedWorkspaceState,
  createResetBackup,
  resetBusinessData
};
