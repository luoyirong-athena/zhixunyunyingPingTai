'use strict';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CAPTURE_TOMBSTONE_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_CAPTURE_TOMBSTONES = 20000;

function pruneCapturePromotionTombstones(value, now = Date.now()) {
  if (!Array.isArray(value)) return { value, removed: 0 };
  const cutoff = now - CAPTURE_TOMBSTONE_RETENTION_MS;
  const dated = [];
  const undated = [];
  value.forEach((item, index) => {
    const time = Date.parse(item?.promotedAt || item?.promoted_at || '');
    if (Number.isFinite(time) && time < cutoff) return;
    (Number.isFinite(time) ? dated : undated).push({ item, index, time });
  });
  // Keep unknown legacy dates conservatively; among dated rows retain the
  // newest entries so a long-running workspace cannot grow without bound.
  dated.sort((left, right) => right.time - left.time || right.index - left.index);
  const retained = [...undated, ...dated.slice(0, Math.max(0, MAX_CAPTURE_TOMBSTONES - undated.length))]
    .sort((left, right) => left.index - right.index)
    .map(({ item }) => item);
  return { value: retained, removed: value.length - retained.length };
}

/**
 * Remove only data that is explicitly past its retention window. In
 * particular, failed and in-flight queue jobs are intentionally excluded so
 * the worker can resume them after a restart.
 */
function runDataMaintenance(db) {
  const result = db.transaction(() => {
    const events = db.prepare(`
      DELETE FROM sync_events
      WHERE created_at IS NOT NULL
        AND created_at < datetime('now', '-90 days')
    `).run();

    const logs = db.prepare(`
      DELETE FROM operation_logs
      WHERE created_at IS NOT NULL
        AND created_at < datetime('now', '-365 days')
    `).run();

    const completedJobs = db.prepare(`
      SELECT id FROM sync_queue_jobs
      WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND completed_at < datetime('now', '-30 days')
    `).all();
    const deleteBatches = db.prepare('DELETE FROM sync_queue_batches WHERE job_id = ?');
    const deleteJob = db.prepare('DELETE FROM sync_queue_jobs WHERE id = ?');
    completedJobs.forEach(({ id }) => {
      deleteBatches.run(id);
      deleteJob.run(id);
    });

    let captureTombstones = 0;
    const hasWorkspaceStates = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_states'").get();
    if (hasWorkspaceStates) {
      const states = db.prepare('SELECT team_id, state_json, version FROM workspace_states WHERE state_json IS NOT NULL').all();
      const updateState = db.prepare(`UPDATE workspace_states
        SET state_json = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`);
      states.forEach((row) => {
        let state;
        try { state = JSON.parse(row.state_json || '{}'); } catch (_) { return; }
        const pruned = pruneCapturePromotionTombstones(state?.capturePromotionTombstones);
        if (!pruned.removed) return;
        updateState.run(JSON.stringify({ ...state, capturePromotionTombstones: pruned.value }), Number(row.version || 0) + 1, row.team_id);
        captureTombstones += pruned.removed;
      });
    }

    return {
      syncEvents: Number(events.changes || 0),
      operationLogs: Number(logs.changes || 0),
      completedJobs: completedJobs.length,
      captureTombstones
    };
  })();

  const total = result.syncEvents + result.operationLogs + result.completedJobs + result.captureTombstones;
  if (total) console.log('[DB] 自动清理历史同步数据', result);
  return result;
}

function startDataMaintenance({ db, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (!db) throw new Error('启动数据维护任务需要数据库连接');
  const run = () => {
    try {
      runDataMaintenance(db);
    } catch (error) {
      console.error('[DB] 自动清理失败', error.message);
    }
  };
  run();
  const timer = setInterval(run, Math.max(60 * 1000, Number(intervalMs) || DEFAULT_INTERVAL_MS));
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { DEFAULT_INTERVAL_MS, CAPTURE_TOMBSTONE_RETENTION_MS, MAX_CAPTURE_TOMBSTONES, pruneCapturePromotionTombstones, runDataMaintenance, startDataMaintenance };
