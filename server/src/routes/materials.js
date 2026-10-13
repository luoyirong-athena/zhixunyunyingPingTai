const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { recordChange, publishEvents } = require('../services/teamEvents');

const execFileAsync = promisify(execFile);
const router = express.Router();
router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);

const UPLOAD_DIR = process.env.ZHIXUN_MATERIALS_DIR || path.join(__dirname, '..', '..', 'data', 'materials');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_SIZE = 800 * 1024 * 1024;
const DEFAULT_TEAM_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const configuredTeamMaxBytes = Number(process.env.ZHIXUN_TEAM_MATERIALS_MAX_BYTES);
const TEAM_MAX_BYTES = Number.isFinite(configuredTeamMaxBytes) && configuredTeamMaxBytes > 0
  ? Math.max(MAX_SIZE, configuredTeamMaxBytes)
  : DEFAULT_TEAM_MAX_BYTES;
const ALLOWED = new Set('doc docx xls xlsx ppt pptx pdf txt jpg jpeg png gif svg psd mp3 wav mp4 zip rar csv json md rtf html'.split(' '));
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    cb(null, ALLOWED.has(ext));
  }
});

function serialize(row) {
  if (!row) return row;
  return { ...row, download_url: `/api/materials/${row.id}/download`, can_execute: ['exe', 'apk'].includes(row.extension) };
}

function removeUploadedFiles(files) {
  for (const file of files || []) {
    try { fs.unlinkSync(file.path); } catch (_) { /* 文件可能已被清理 */ }
  }
}

const PREVIEW_MAX_SIZE = 50 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_SIZE = 10 * 1024 * 1024;
const PREVIEW_WORKER = path.join(__dirname, '..', 'workers', 'materialPreviewWorker.js');
const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml' };

function safeTextPreview(filePath, extension) {
  const limit = 500 * 1024;
  const buffer = fs.readFileSync(filePath);
  const partial = buffer.length > limit;
  let content = buffer.subarray(0, limit).toString('utf8').replace(/^\uFEFF/, '');
  if (extension === 'json') {
    try { content = JSON.stringify(JSON.parse(content), null, 2); } catch (_) { /* 保留原始文本 */ }
  }
  return { kind: 'text', content, partial };
}

async function spreadsheetPreview(filePath, sheet, offset, limit) {
  const args = ['--disable-proto=throw', PREVIEW_WORKER, filePath, String(sheet || ''), String(offset), String(limit)];
  const { stdout } = await execFileAsync(process.execPath, args, {
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  return JSON.parse(stdout);
}

const STABLE_CONVERSIONS = new Set(['txt', 'md', 'json', 'csv', 'html', 'rtf']);
function normalizeCategory(value) {
  const category = String(value || '资料文件').trim().slice(0, 50);
  return category || '资料文件';
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function convertTextContent(text, source, target) {
  if (source === target) return { content: text, mime: 'text/plain; charset=utf-8' };
  if (target === 'txt' || target === 'md') return { content: text, mime: 'text/plain; charset=utf-8' };
  if (target === 'json') {
    if (source === 'json') return { content: JSON.stringify(JSON.parse(text), null, 2), mime: 'application/json; charset=utf-8' };
    return { content: JSON.stringify({ content: text }, null, 2), mime: 'application/json; charset=utf-8' };
  }
  if (target === 'csv') {
    if (source === 'json') {
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const keys = [...new Set(rows.flatMap(row => row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row) : ['内容']))];
      const lines = [keys.map(csvCell).join(',')];
      rows.forEach(row => lines.push(keys.map(key => csvCell(row && typeof row === 'object' && !Array.isArray(row) ? row[key] : row)).join(',')));
      return { content: lines.join('\n'), mime: 'text/csv; charset=utf-8' };
    }
    return { content: text.split(/\r?\n/).map(csvCell).join('\n'), mime: 'text/csv; charset=utf-8' };
  }
  if (target === 'html') {
    if (source === 'html') return { content: text, mime: 'text/html; charset=utf-8' };
    return { content: `<!doctype html><html><head><meta charset="utf-8"><title>资料转换</title></head><body><pre>${escapeHtml(text)}</pre></body></html>`, mime: 'text/html; charset=utf-8' };
  }
  if (target === 'rtf') {
    if (source === 'rtf') return { content: text, mime: 'application/rtf' };
    const safe = text.replace(/\\/g, '\\\\').replace(/[{}]/g, ch => `\\${ch}`).replace(/\r?\n/g, '\\par ');
    return { content: `{\\rtf1\\ansi ${safe}}`, mime: 'application/rtf' };
  }
  throw new Error('没有稳定的转换方式');
}

router.get('/', (req, res) => {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM materials_files WHERE team_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(req.team.id);
  res.json({ data: rows.map(serialize) });
});

router.post('/upload', upload.array('files', 10), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: '没有成功上传文件；仅支持已配置的资料格式，单个文件最大 800MB' });
  const db = getDatabase();
  const incomingBytes = files.reduce((total, file) => total + Number(file.size || 0), 0);
  const currentBytes = Number(db.prepare('SELECT COALESCE(SUM(size_bytes), 0) total FROM materials_files WHERE team_id = ? AND deleted_at IS NULL').get(req.team.id).total || 0);
  if (currentBytes + incomingBytes > TEAM_MAX_BYTES) {
    removeUploadedFiles(files);
    return res.status(413).json({ error: `团队资料容量已达到上限（${Math.round(TEAM_MAX_BYTES / 1024 / 1024 / 1024)}GB），请删除旧资料后再上传` });
  }
  const category = normalizeCategory(req.body?.category);
  const insert = db.prepare(`INSERT INTO materials_files (user_id, team_id, created_by_user_id, updated_by_user_id, version, original_name, stored_name, mime_type, extension, size_bytes, storage_path, category)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`);
  const events = [];
  const rows = files.map(file => {
    // 修复中文文件名乱码：latin1 → utf8 转码
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(originalName).slice(1).toLowerCase();
    const result = insert.run(req.user.id, req.team.id, req.user.id, req.user.id, originalName, file.filename, file.mimetype, ext, file.size, file.path, category);
    const row = serialize(db.prepare('SELECT * FROM materials_files WHERE id = ?').get(result.lastInsertRowid));
    events.push(recordChange(db, req, { entityType: 'material', entityId: row.id, action: 'knowledge.created', version: row.version, after: row, payload: { materialId: row.id } }));
    return row;
  });
  publishEvents(req.team.id, events);
  res.status(201).json({ data: rows, message: '资料已上传并保留原格式' });
});

router.get('/:id/preview', async (req, res) => {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM materials_files WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(req.params.id, req.team.id);
  if (!row) return res.status(404).json({ error: '资料不存在' });
  if (!fs.existsSync(row.storage_path)) return res.status(404).json({ error: '资料文件不存在' });
  const extension = String(row.extension || '').toLowerCase();
  const size = Number(row.size_bytes || fs.statSync(row.storage_path).size || 0);
  const base = {
    materialId: row.id, fileName: row.original_name, extension, category: row.category || '资料文件',
    sizeBytes: size, createdAt: row.created_at, updatedAt: row.updated_at, downloadUrl: `/api/materials/${row.id}/download`
  };
  if (size > PREVIEW_MAX_SIZE) {
    return res.status(413).json({ ...base, kind: 'unsupported', partial: true, error: '文件超过 50MB，暂不在线解析，请下载原文件查看' });
  }
  try {
    if (['xls', 'xlsx', 'csv'].includes(extension)) {
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 200));
      const data = await spreadsheetPreview(row.storage_path, req.query.sheet || '', offset, limit);
      return res.json({ ...base, kind: 'spreadsheet', ...data });
    }
    if (['txt', 'md', 'json'].includes(extension)) return res.json({ ...base, ...safeTextPreview(row.storage_path, extension) });
    if (IMAGE_MIME[extension]) {
      if (size > IMAGE_PREVIEW_MAX_SIZE) return res.status(413).json({ ...base, kind: 'unsupported', error: '图片超过 10MB，请下载原文件查看' });
      const dataUrl = `data:${IMAGE_MIME[extension]};base64,${fs.readFileSync(row.storage_path).toString('base64')}`;
      return res.json({ ...base, kind: 'image', dataUrl, partial: false });
    }
    return res.json({ ...base, kind: 'unsupported', partial: false, message: '当前文件格式暂不支持在线预览，可下载原文件查看。' });
  } catch (error) {
    const timedOut = error?.killed || error?.signal === 'SIGTERM';
    return res.status(422).json({ ...base, kind: 'unsupported', partial: true, error: timedOut ? '表格解析超时，请下载原文件查看' : '资料预览失败，原文件未受影响，可下载查看' });
  }
});

router.get('/:id/download', (req, res) => {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM materials_files WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(req.params.id, req.team.id);
  if (!row || !fs.existsSync(row.storage_path)) return res.status(404).json({ error: '资料不存在' });
  res.download(row.storage_path, row.original_name);
});

router.delete('/:id', (req, res) => {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM materials_files WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(req.params.id, req.team.id);
  if (!row) return res.status(404).json({ error: '资料不存在' });
  const events = [];
  db.transaction(() => {
    db.prepare('UPDATE materials_jobs SET deleted_at=CURRENT_TIMESTAMP, deleted_by_user_id=?, updated_by_user_id=?, version=version+1 WHERE material_id=? AND team_id=? AND deleted_at IS NULL').run(req.user.id, req.user.id, row.id, req.team.id);
    db.prepare('UPDATE materials_files SET deleted_at=CURRENT_TIMESTAMP, deleted_by_user_id=?, updated_by_user_id=?, version=version+1 WHERE id=? AND team_id=?').run(req.user.id, req.user.id, row.id, req.team.id);
    const deleted = db.prepare('SELECT * FROM materials_files WHERE id=?').get(row.id);
    events.push(recordChange(db, req, { entityType: 'material', entityId: row.id, action: 'knowledge.deleted', version: deleted.version, before: row, after: { deleted_at: deleted.deleted_at }, payload: { materialId: row.id } }));
  })();
  publishEvents(req.team.id, events);
  res.json({ message: '资料已删除' });
});

router.post('/:id/convert', (req, res) => {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM materials_files WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(req.params.id, req.team.id);
  if (!row) return res.status(404).json({ error: '资料不存在' });
  const target = String(req.body?.target_format || '').replace(/^\./, '').toLowerCase();
  if (!STABLE_CONVERSIONS.has(target) || !STABLE_CONVERSIONS.has(row.extension)) {
    return res.json({ status: 'original_only', message: '当前格式没有稳定转换器，已保留原格式下载', original: serialize(row) });
  }
  if (!fs.existsSync(row.storage_path)) return res.status(404).json({ error: '资料文件不存在' });
  try {
    const source = fs.readFileSync(row.storage_path).toString('utf8').replace(/^\uFEFF/, '');
    const converted = convertTextContent(source, row.extension, target);
    const job = db.prepare(`INSERT INTO materials_jobs (user_id, team_id, created_by_user_id, updated_by_user_id, version, material_id, job_type, target_format, status, message) VALUES (?, ?, ?, ?, 1, ?, 'convert', ?, 'completed', ?)`)
      .run(req.user.id, req.team.id, req.user.id, req.user.id, row.id, target, '已完成稳定格式转换；原文件仍保留');
    const base = row.original_name.replace(/\.[^.]*$/, '') || '资料';
    const filename = `${base}.${target}`;
    res.set({ 'Content-Type': converted.mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'X-Material-Job-Id': String(job.lastInsertRowid) });
    return res.send(Buffer.from(converted.content, 'utf8'));
  } catch (error) {
    db.prepare(`INSERT INTO materials_jobs (user_id, team_id, created_by_user_id, updated_by_user_id, version, material_id, job_type, target_format, status, message) VALUES (?, ?, ?, ?, 1, ?, 'convert', ?, 'original_only', ?)`)
      .run(req.user.id, req.team.id, req.user.id, req.user.id, row.id, target, `转换失败，已保留原格式：${error.message}`);
    return res.json({ status: 'original_only', message: '转换失败，已保留原格式下载', original: serialize(row) });
  }
});

router.post('/:id/execute', (req, res) => {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM materials_files WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(req.params.id, req.team.id);
  if (!row) return res.status(404).json({ error: '资料不存在' });
  if (!['exe', 'apk'].includes(row.extension)) return res.status(400).json({ error: '只有 exe/apk 文件允许申请在线执行' });
  // 生产环境必须接入独立容器/虚拟机沙箱；主服务绝不直接执行用户上传文件。
  const job = db.prepare(`INSERT INTO materials_jobs (user_id, team_id, created_by_user_id, updated_by_user_id, version, material_id, job_type, status, message) VALUES (?, ?, ?, ?, 1, ?, 'execute', 'sandbox_unavailable', ?)`)
    .run(req.user.id, req.team.id, req.user.id, req.user.id, row.id, '安全执行沙箱尚未配置，文件已保留但不会在主机进程中执行');
  res.status(503).json({ status: 'sandbox_unavailable', job_id: job.lastInsertRowid, message: '当前部署未启用隔离执行服务，为安全起见暂不能在线执行。' });
});

router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '单个文件不能超过 800MB' });
  if (err) { console.error('[materials]', err); return res.status(400).json({ error: '资料上传失败' }); }
  res.status(500).json({ error: '资料服务异常' });
});

module.exports = router;
