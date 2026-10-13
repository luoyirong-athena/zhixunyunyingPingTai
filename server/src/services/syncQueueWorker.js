const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { getDatabase } = require('../config/database');
const { createToken } = require('../middleware/auth');
const { restoreFullBackup } = require('./fullBackup');
const { publishEvents } = require('./teamEvents');
const {
  notifyQueueCompleted,
  notifyQueueFailed,
  notifyQueueProgress,
  notifyQueueRetrying
} = require('./syncQueueNotifications');

const RETRY_DELAYS = [1500, 3000, 6000, 12000, 30000, 60000];
const MAX_RETRY_ATTEMPTS = 8;
const VALID_OPERATIONS = new Set(['patch', 'backup', 'import', 'directImport', 'safeReplacementPending', 'promote', 'capturePromote', 'delete', 'captureDelete', 'replace', 'fullBackupRestore']);
let workerTimer = null;
let workerRunning = false;

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function patchIsEmpty(patch) {
  return !patch
    || (!Object.keys(patch.replace || {}).length
      && !Object.keys(patch.arrays || {}).some(key => {
        const change = patch.arrays[key] || {};
        return change.replace !== undefined
          || (change.add || []).length
          || (change.update || []).length
          || (change.remove || []).length;
      }));
}

function time(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordFieldTime(record, field) {
  return time(record?.fieldUpdatedAt?.[field] || record?.field_updated_at?.[field])
    || time(record?.updatedAt || record?.updated_at || record?.createdAt || record?.created_at);
}

function discardStaleUpdates(patch, snapshotState) {
  if (!patch || typeof patch !== 'object') return patch;
  const nextPatch = JSON.parse(JSON.stringify(patch));
  for (const [key, change] of Object.entries(nextPatch.arrays || {})) {
    const records = new Map((snapshotState?.[key] || []).map(record => [String(record?.id), record]));
    if (change?.update?.length) {
      change.update = change.update.map(item => {
        const current = records.get(String(item?.id));
        if (!current) return null;
        const incomingMeta = item?.fields?.fieldUpdatedAt || item?.fields?.field_updated_at || {};
        const fields = {};
        for (const [field, value] of Object.entries(item?.fields || {})) {
          if (field === 'fieldUpdatedAt' || field === 'field_updated_at') continue;
          const incoming = time(incomingMeta[field]) || time(item?.fields?.updatedAt || item?.fields?.updated_at);
          const currentTime = recordFieldTime(current, field);
          if (incoming && currentTime && incoming < currentTime) continue;
          fields[field] = value;
        }
        if (Object.keys(fields).length && Object.keys(incomingMeta).length) {
          fields.fieldUpdatedAt = Object.fromEntries(Object.entries(incomingMeta).filter(([field]) => field in fields));
        }
        return Object.keys(fields).length ? { ...item, fields } : null;
      }).filter(Boolean);
    }
    if (change?.remove?.length) {
      change.remove = change.remove.filter(entry => {
        if (!entry || typeof entry !== 'object') return true;
        const current = records.get(String(entry.id));
        const incoming = time(entry.deletedAt || entry.updatedAt);
        const currentTime = time(current?.updatedAt || current?.updated_at || current?.createdAt || current?.created_at);
        return !incoming || !currentTime || incoming >= currentTime;
      });
    }
  }
  return nextPatch;
}

function delayFor(attempt) {
  return RETRY_DELAYS[Math.min(Math.max(0, attempt - 1), RETRY_DELAYS.length - 1)];
}

function isTransient(error) {
  return error?.code === 'SYNC_NETWORK_ERROR'
    || error?.code === 'SYNC_TEMPORARY_FAILURE'
    || [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(error?.status));
}

function requestJson({ port, secure, path, token, method = 'GET', body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const transport = secure ? https : http;
    const request = transport.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      rejectUnauthorized: false,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        })
      }
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text || '服务端返回了无效响应' }; }
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(data);
        const error = new Error(data.error || `同步请求失败（${response.statusCode}）`);
        error.status = response.statusCode;
        error.data = data;
        error.code = data.code;
        reject(error);
      });
    });
    request.setTimeout(30000, () => request.destroy(Object.assign(new Error('同步请求超时'), { code: 'SYNC_NETWORK_ERROR' })));
    request.on('error', error => {
      if (!error.code) error.code = 'SYNC_NETWORK_ERROR';
      reject(error);
    });
    if (payload) request.write(payload);
    request.end();
  });
}

function claimNext(db) {
  return db.transaction(() => {
    const job = db.prepare(`SELECT * FROM sync_queue_jobs
      WHERE status IN ('pending', 'retrying')
        AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
      ORDER BY priority DESC, id LIMIT 1`).get();
    if (!job) return null;
    const batch = db.prepare(`SELECT * FROM sync_queue_batches
      WHERE job_id = ? AND status IN ('pending', 'retrying')
      ORDER BY batch_index LIMIT 1`).get(job.id);
    if (!batch) {
      const registered = Number(db.prepare('SELECT COUNT(*) count FROM sync_queue_batches WHERE job_id = ?').get(job.id).count || 0);
      // The browser registers batches one by one. Do not close a job while
      // later batches are still on their way to the server.
      if (registered < Number(job.total_batches || 0)) return null;
      db.prepare(`UPDATE sync_queue_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(job.id);
      return null;
    }
    db.prepare(`UPDATE sync_queue_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(job.id);
    db.prepare(`UPDATE sync_queue_batches SET status = 'running', attempts = attempts + 1,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(batch.id);
    return { job, batch };
  })();
}

function markCompleted(db, job, batch, response) {
  let complete = false;
  db.transaction(() => {
    db.prepare(`UPDATE sync_queue_batches SET status = 'completed', response_json = ?,
      last_error = NULL, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(JSON.stringify(response || {}), batch.id);
    const registered = Number(db.prepare('SELECT COUNT(*) count FROM sync_queue_batches WHERE job_id = ?').get(job.id).count || 0);
    const remaining = db.prepare(`SELECT COUNT(*) count FROM sync_queue_batches
      WHERE job_id = ? AND status != 'completed'`).get(job.id).count;
    complete = registered >= Number(job.total_batches || 0) && Number(remaining) === 0;
    db.prepare(`UPDATE sync_queue_jobs SET status = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP,
      completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id = ?`)
      .run(complete ? 'completed' : 'pending', complete ? 1 : 0, job.id);
  })();
  const currentJob = db.prepare('SELECT * FROM sync_queue_jobs WHERE id = ?').get(job.id);
  notifyQueueProgress(db, currentJob);
  if (complete) notifyQueueCompleted(db, currentJob);
}

function markRetry(db, job, batch, error) {
  const attempt = Number(batch.attempts || 1);
  const seconds = Math.ceil(delayFor(attempt) / 1000);
  const message = String(error?.message || '同步暂时失败').slice(0, 500);
  db.transaction(() => {
    db.prepare(`UPDATE sync_queue_batches SET status = 'retrying', last_error = ?,
      next_attempt_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(message, `+${seconds} seconds`, batch.id);
    db.prepare(`UPDATE sync_queue_jobs SET status = 'retrying', attempts = attempts + 1,
      last_error = ?, next_attempt_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(message, `+${seconds} seconds`, job.id);
  })();
  notifyQueueRetrying(db, db.prepare('SELECT * FROM sync_queue_jobs WHERE id = ?').get(job.id), message);
}

function markFailed(db, job, batch, error) {
  const message = String(error?.message || '同步失败').slice(0, 500);
  db.transaction(() => {
    db.prepare(`UPDATE sync_queue_batches SET status = 'failed', last_error = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(message, batch.id);
    db.prepare(`UPDATE sync_queue_jobs SET status = 'failed', last_error = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(message, job.id);
  })();
  notifyQueueFailed(db, job, message);
}

async function executeBatch(job, batch, options) {
  if (!VALID_OPERATIONS.has(job.operation)) throw new Error('服务端同步任务类型无效');
  const payload = parseJson(batch.payload_json, null);
  if (!payload || typeof payload !== 'object') throw new Error('服务端同步批次内容无效');
  const user = getDatabase().prepare('SELECT id, username, role, display_name, token_version, status FROM users WHERE id = ?').get(job.user_id);
  if (!user || user.status === 'disabled') throw Object.assign(new Error('执行同步任务的账号已停用'), { status: 403 });
  const token = createToken(user);
  const call = (path, body) => requestJson({ ...options, path, token, method: 'POST', body });

  if (job.operation === 'fullBackupRestore') {
    if (user.role !== 'admin') throw Object.assign(new Error('只有管理员可以恢复完整备份'), { status: 403 });
    const db = getDatabase();
    const team = db.prepare('SELECT id, code, name, priority_config FROM teams WHERE id = ?').get(job.team_id);
    if (!team) throw Object.assign(new Error('备份恢复所属团队不存在'), { status: 404 });
    const stagedPath = path.resolve(String(payload.stagedPath || ''));
    const uploadRoot = path.resolve(String(payload.uploadRoot || path.dirname(stagedPath)));
    if (!stagedPath || (stagedPath !== uploadRoot && !stagedPath.startsWith(`${uploadRoot}${path.sep}`))) {
      throw new Error('备份恢复文件路径无效');
    }
    if (!fs.existsSync(stagedPath)) throw new Error('备份恢复文件不存在或已被清理');
    const request = {
      team,
      user,
      ip: String(payload.ip || ''),
      get(name) {
        const key = String(name || '').toLowerCase();
        if (key === 'x-request-id') return job.queue_id;
        if (key === 'user-agent') return String(payload.userAgent || 'sync-queue-worker');
        return '';
      }
    };
    const result = await restoreFullBackup(db, request, stagedPath);
    publishEvents(team.id, result.events || []);
    return {
      accepted: 1,
      restoredFiles: Number(result.restoredFiles || 0),
      version: Number(result.version || 0),
      remappedUserReferences: result.remappedUserReferences || { total: 0 }
    };
  }

  if (job.operation === 'patch' || job.operation === 'backup') {
    let body = { ...payload };
    for (let conflictAttempt = 0; conflictAttempt < 4; conflictAttempt += 1) {
      try {
        return await call(job.operation === 'backup' ? '/api/sync/backup-merge-batch' : '/api/sync/patch-batch', body);
      } catch (error) {
        if (error.status !== 409) throw error;
        const snapshot = await requestJson({ ...options, path: '/api/sync/snapshot', token });
        const patch = discardStaleUpdates(body.patch, snapshot.state);
        if (patchIsEmpty(patch)) return { accepted: true, version: Number(snapshot.version || 0), skippedStale: true };
        body = { ...body, baseVersion: Number(snapshot.version || 0), patch };
      }
    }
    throw Object.assign(new Error('同步冲突次数过多，请稍后重试'), { status: 409 });
  }

  if (job.operation === 'directImport') {
    const imported = await call('/api/sync/import-batch', payload.import);
    const promoted = await call('/api/sync/promote-batch', payload.promote);
    return { imported, promoted };
  }
  const endpoint = {
    safeReplacementPending: '/api/sync/safe-replacement-pending-batch',
    promote: '/api/sync/promote-batch',
    capturePromote: '/api/sync/promote-capture-batch',
    delete: '/api/sync/delete-customer-batch',
    captureDelete: '/api/sync/delete-capture-batch',
    replace: '/api/sync/replace-duplicate-batch'
  }[job.operation];
  if (job.operation === 'import') {
    // A queued customer import always targets pending customers. Older
    // clients could persist stale capture rows, so discard them here instead
    // of allowing the import endpoint's legacy capture validation to fail.
    return call('/api/sync/import-batch', {
      ...payload,
      captures: [],
      captureMode: 'none'
    });
  }
  return call(endpoint, payload);
}

function cleanupFullBackupPayload(batch) {
  const payload = parseJson(batch?.payload_json, {});
  const stagedPath = String(payload.stagedPath || '');
  if (!stagedPath) return;
  try { fs.rmSync(stagedPath, { force: true }); } catch (_) { /* retention cleanup can remove it later */ }
}

async function runOnce(options) {
  const db = getDatabase();
  const claimed = claimNext(db);
  if (!claimed) return;
  const { job, batch } = claimed;
  try {
    const response = await executeBatch(job, batch, options);
    markCompleted(db, job, batch, response);
    if (job.operation === 'fullBackupRestore') cleanupFullBackupPayload(batch);
  } catch (error) {
    if (isTransient(error) && Number(batch.attempts || 0) + 1 < MAX_RETRY_ATTEMPTS) markRetry(db, job, batch, error);
    else {
      markFailed(db, job, batch, error);
      if (job.operation === 'fullBackupRestore') cleanupFullBackupPayload(batch);
    }
  }
}

function startSyncQueueWorker({ port, secure = false } = {}) {
  const db = getDatabase();
  db.prepare("UPDATE sync_queue_jobs SET status = 'pending', next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'running'").run();
  db.prepare("UPDATE sync_queue_batches SET status = 'pending', next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'running'").run();
  const options = { port: Number(port), secure: Boolean(secure) };
  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try { await runOnce(options); } catch (error) { console.error('[SyncQueueWorker] tick failed', error.message); }
    workerRunning = false;
  };
  tick();
  workerTimer = setInterval(tick, 250);
  workerTimer.unref?.();
  console.log('[SyncQueueWorker] persistent server queue worker started');
  return () => { if (workerTimer) clearInterval(workerTimer); workerTimer = null; };
}

module.exports = { startSyncQueueWorker };
