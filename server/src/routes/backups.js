'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const express = require('express');
const { getDatabase } = require('../config/database');
const { authRequired, adminRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { streamFullBackup } = require('../services/fullBackup');
const { notifyQueueAccepted } = require('../services/syncQueueNotifications');

const router = express.Router();
const uploadRoot = path.resolve(process.env.ZHIXUN_BACKUP_UPLOAD_DIR || path.join(os.tmpdir(), 'zhixun-backup-upload'));
fs.mkdirSync(uploadRoot, { recursive: true });
// Backup size is bounded by available disk space instead of an arbitrary
// request limit. Multer streams the multipart file directly to this folder.
const upload = multer({ dest: uploadRoot, limits: { files: 1 } });
router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);

function receiveBackup(req, res, next) {
  upload.single('backup')(req, res, error => {
    if (!error) return next();
    if (req.file?.path) {
      try { fs.rmSync(req.file.path, { force: true }); } catch (_) { /* temporary upload cleanup */ }
    }
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.code === 'LIMIT_FILE_COUNT' ? '每次只能导入一个备份文件' : '备份文件上传失败' });
    }
    return next(error);
  });
}

router.get('/export', (req, res, next) => {
  try {
    const result = streamFullBackup(getDatabase(), req, res);
    Promise.resolve(result).catch(next);
  } catch (error) {
    next(error);
  }
});

router.post('/restore', adminRequired, (req, res, next) => {
  req.setTimeout(0);
  res.setTimeout(0);
  next();
}, receiveBackup, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择 ZIP 完整备份文件' });
  const queueId = String(req.get('X-Request-Id') || `full-backup-restore-${crypto.randomUUID()}`).slice(0, 160);
  const stagedPath = path.join(uploadRoot, `${queueId.replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`);
  try {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM sync_queue_jobs WHERE team_id = ? AND queue_id = ?').get(req.team.id, queueId);
    if (existing) {
      if (existing.user_id !== req.user.id || existing.operation !== 'fullBackupRestore') {
        throw Object.assign(new Error('备份任务编号已被其他任务使用'), { statusCode: 409 });
      }
      try { fs.rmSync(req.file.path, { force: true }); } catch (_) { /* duplicate upload cleanup */ }
      return res.status(202).json({
        jobId: queueId,
        status: existing.status,
        totalBatches: 1,
        completedBatches: existing.status === 'completed' ? 1 : 0,
        serverPersisted: true,
        created: false
      });
    }
    fs.renameSync(req.file.path, stagedPath);
    let job;
    let created = false;
    db.transaction(() => {
      job = db.prepare('SELECT * FROM sync_queue_jobs WHERE team_id = ? AND queue_id = ?').get(req.team.id, queueId);
      if (job) throw Object.assign(new Error('备份任务编号已被其他任务使用'), { statusCode: 409 });
      db.prepare(`INSERT INTO sync_queue_jobs
        (queue_id, team_id, user_id, operation, total_batches, priority, status, next_attempt_at)
        VALUES (?, ?, ?, 'fullBackupRestore', 1, 90, 'pending', NULL)`)
        .run(queueId, req.team.id, req.user.id);
      job = db.prepare('SELECT * FROM sync_queue_jobs WHERE team_id = ? AND queue_id = ?').get(req.team.id, queueId);
      const payload = {
        stagedPath,
        uploadRoot,
        originalName: req.file.originalname || '完整备份.zip',
        size: Number(req.file.size || 0),
        ip: req.ip || '',
        userAgent: req.get('user-agent') || ''
      };
      db.prepare(`INSERT INTO sync_queue_batches
        (job_id, batch_index, total_batches, payload_json, status, next_attempt_at)
        VALUES (?, 0, 1, ?, 'pending', NULL)`).run(job.id, JSON.stringify(payload));
      created = true;
    })();
    if (created) notifyQueueAccepted(db, job);
    return res.status(202).json({
      jobId: queueId,
      status: job.status,
      totalBatches: 1,
      completedBatches: job.status === 'completed' ? 1 : 0,
      serverPersisted: true,
      created
    });
  } catch (error) {
    const status = Number(error.statusCode) >= 400 && Number(error.statusCode) < 600 ? error.statusCode : 400;
    try { fs.rmSync(req.file.path, { force: true }); } catch (_) { /* temporary upload cleanup */ }
    try { fs.rmSync(stagedPath, { force: true }); } catch (_) { /* temporary upload cleanup */ }
    return res.status(status).json({ error: error.message || '完整备份恢复失败，原数据未修改' });
  }
});

module.exports = router;
