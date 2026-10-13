'use strict';

const { createSyncEvent, publish, operatorName, operatorUsername } = require('./syncHub');

function parsePayload(value) {
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

function safeReason(value) {
  return String(value || '').replace(/[“\"][^”\"]*[”\"]/g, '相关数据').slice(0, 500);
}

function batchCount(operation, payload) {
  if (operation === 'directImport') return Number(payload.import?.customers?.length || 0);
  if (operation === 'import') return Number(payload.customers?.length || 0);
  if (operation === 'promote' || operation === 'delete') return Number(payload.customerIds?.length || 0);
  if (operation === 'capturePromote') return Number(payload.captureIds?.length || payload.captures?.length || 0);
  if (operation === 'captureDelete') return Number(payload.captureIds?.length || 0);
  if (operation === 'replace') return Number(payload.items?.length || 0);
  if (operation === 'fullBackupRestore') return 1;
  const patch = payload.patch || {};
  return Object.values(patch.arrays || {}).reduce((total, change) => total
    + Number(change?.add?.length || 0) + Number(change?.update?.length || 0)
    + Number(change?.remove?.length || 0) + (change?.replace ? 1 : 0), 0);
}

function queueRowCount(db, job) {
  const batches = db.prepare('SELECT payload_json FROM sync_queue_batches WHERE job_id = ?').all(job.id);
  const count = batches.reduce((total, batch) => total + batchCount(job.operation, parsePayload(batch.payload_json)), 0);
  return count || null;
}

function queueProgress(db, job) {
  const rows = db.prepare('SELECT status, response_json FROM sync_queue_batches WHERE job_id = ?').all(job.id);
  return {
    completedBatches: rows.filter(row => row.status === 'completed').length,
    retryingBatches: rows.filter(row => row.status === 'retrying').length,
    failedBatches: rows.filter(row => row.status === 'failed').length,
    totalBatches: Number(job.total_batches || 0),
    rowCount: queueRowCount(db, job)
  };
}

function notify(db, job, action, payload = {}, audienceUserId = null) {
  const event = createSyncEvent(db, {
    teamId: job.team_id,
    entityType: 'sync_job',
    entityId: job.queue_id,
    action,
    entityVersion: 0,
    operatorUserId: job.user_id,
    requestId: job.queue_id,
    payload: {
      operation: job.operation,
      queueId: job.queue_id,
      operatorName: operatorName(db, job.user_id),
      operatorUsername: operatorUsername(db, job.user_id),
      ...(audienceUserId == null ? {} : { audienceUserId }),
      ...payload
    }
  });
  publish(job.team_id, event);
  return event;
}

function notifyQueueAccepted(db, job) {
  notify(db, job, 'sync.operation.accepted', queueProgress(db, job), job.user_id);
}

function notifyQueueProgress(db, job) {
  notify(db, job, 'sync.operation.progress', queueProgress(db, job), job.user_id);
}

function notifyQueueRetrying(db, job, reason) {
  notify(db, job, 'sync.operation.retrying', {
    ...queueProgress(db, job),
    reason: safeReason(reason || '网络暂时中断，系统正在自动重试')
  }, job.user_id);
}

function notifyQueueCompleted(db, job) {
  notify(db, job, 'sync.operation.completed', queueProgress(db, job));
}

function notifyQueueFailed(db, job, reason) {
  notify(db, job, 'sync.operation.failed', {
    ...queueProgress(db, job),
    reason: safeReason(reason || '同步失败')
  }, job.user_id);
}

module.exports = {
  notifyQueueAccepted,
  notifyQueueCompleted,
  notifyQueueFailed,
  notifyQueueProgress,
  notifyQueueRetrying
};
