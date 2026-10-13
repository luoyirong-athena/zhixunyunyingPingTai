'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { createSyncEvent } = require('./syncHub');

const DATA_DIR = path.resolve(process.env.ZHIXUN_DATA_DIR || path.join(__dirname, '..', '..', 'data'));
const MATERIALS_DIR = path.resolve(process.env.ZHIXUN_MATERIALS_DIR || path.join(DATA_DIR, 'materials'));
const EVIDENCE_DIR = path.resolve(process.env.ZHIXUN_CUSTOMER_EVIDENCE_DIR || path.join(DATA_DIR, 'customer-evidence'));
const MIN_FREE_DISK_RESERVE = 256 * 1024 * 1024;

const WORKSPACE_USER_REFERENCE_KEYS = new Set([
  'user_id', 'userId',
  'created_by_user_id', 'createdByUserId',
  'updated_by_user_id', 'updatedByUserId',
  'deleted_by_user_id', 'deletedByUserId',
  'initialized_by_user_id', 'initializedByUserId',
  'operator_user_id', 'operatorUserId',
  'owner_user_id', 'ownerUserId',
  'requester_user_id', 'requesterUserId',
  'decided_by_user_id', 'decidedByUserId'
]);

const METADATA_TABLES = [
  'customers',
  'tasks',
  'feedback',
  'chat_records',
  'experiences',
  'tags',
  'product_requests',
  'sales_statuses',
  'customer_status_history',
  'workspace_customer_status_history',
  'materials_files',
  'materials_jobs',
  'knowledge_relations',
  'customer_evidence',
  'customer_data_permissions'
];

const DELETE_ORDER = [
  'materials_jobs',
  'customer_evidence',
  'customer_data_permissions',
  'workspace_customer_status_history',
  'customer_status_history',
  'chat_records',
  'tasks',
  'feedback',
  'knowledge_relations',
  'materials_files',
  'product_requests',
  'tags',
  'experiences',
  'sales_statuses',
  'customers'
];

const INSERT_ORDER = [
  'customers',
  'sales_statuses',
  'tags',
  'experiences',
  'product_requests',
  'feedback',
  'tasks',
  'chat_records',
  'customer_status_history',
  'workspace_customer_status_history',
  'materials_files',
  'materials_jobs',
  'knowledge_relations',
  'customer_evidence',
  'customer_data_permissions'
];

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function safeFileName(value, fallback) {
  const name = String(value || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\.+/, '').slice(0, 180);
  return name || fallback;
}

function activeRows(db, table, teamId) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  const deleted = columns.has('deleted_at') ? ' AND deleted_at IS NULL' : '';
  return db.prepare(`SELECT * FROM ${table} WHERE team_id = ?${deleted}`).all(teamId);
}

function allowedFilePath(value, root) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function addArchivedFiles(archive, rows, { pathKey, root, archiveDir, nameFor }) {
  const missing = [];
  for (const row of rows) {
    const source = allowedFilePath(row[pathKey], root);
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      row.archive_path = '';
      missing.push({ id: row.id, file: row[pathKey] || '' });
      continue;
    }
    const archivePath = `${archiveDir}/${row.id}-${safeFileName(nameFor(row), path.basename(source))}`;
    row.archive_path = archivePath;
    archive.file(source, { name: archivePath });
  }
  return missing;
}

function streamFullBackup(db, req, res) {
  const workspace = db.prepare('SELECT state_json, version, updated_at FROM workspace_states WHERE team_id = ?').get(req.team.id);
  if (!workspace || Number(workspace.version || 0) <= 0) {
    const error = new Error('团队工作区尚未初始化，无法导出完整备份');
    error.statusCode = 409;
    throw error;
  }
  const team = db.prepare('SELECT id, code, name, priority_config FROM teams WHERE id = ?').get(req.team.id);
  const metadata = {};
  METADATA_TABLES.forEach(table => { metadata[table] = activeRows(db, table, req.team.id); });
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', error => { if (error.code !== 'ENOENT') res.destroy(error); });
  archive.on('error', error => res.destroy(error));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="zhixun-full-backup-${Date.now()}.zip"`);
  archive.pipe(res);

  const missingFiles = [
    ...addArchivedFiles(archive, metadata.materials_files, {
      pathKey: 'storage_path', root: MATERIALS_DIR, archiveDir: 'files/materials',
      nameFor: row => row.original_name || row.stored_name
    }).map(item => ({ type: 'material', ...item })),
    ...addArchivedFiles(archive, metadata.customer_evidence, {
      pathKey: 'file_path', root: EVIDENCE_DIR, archiveDir: 'files/customer-evidence',
      nameFor: row => row.file_name
    }).map(item => ({ type: 'customer-evidence', ...item }))
  ];
  const manifest = {
    formatVersion: 1,
    type: 'zhixun-full-backup',
    createdAt: new Date().toISOString(),
    team: { id: team.id, code: team.code, name: team.name, priorityConfig: team.priority_config || null },
    workspaceVersion: Number(workspace.version || 0),
    tables: Object.fromEntries(METADATA_TABLES.map(table => [table, metadata[table].length])),
    missingFiles
  };
  archive.append(safeJson(manifest), { name: 'manifest.json' });
  archive.append(safeJson({ version: Number(workspace.version || 0), state: JSON.parse(workspace.state_json || '{}') }), { name: 'workspace.json' });
  archive.append(safeJson(metadata), { name: 'metadata.json' });
  return archive.finalize();
}

function safeArchivePath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  const normalized = path.posix.normalize(raw);
  if (!raw || raw.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`备份中包含不安全的文件路径：${raw || '(空)'}`);
  }
  return normalized;
}

async function readJsonEntry(entries, name) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`备份缺少 ${name}`);
  const buffer = await entry.buffer();
  try { return JSON.parse(buffer.toString('utf8')); } catch (_) { throw new Error(`${name} 内容不是有效 JSON`); }
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function userReferenceColumns(db, table) {
  return new Set(db.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .filter(row => row.table === 'users' && row.to === 'id')
    .map(row => row.from));
}

function remapMissingUserReferences(db, metadata, workspaceState, fallbackUserId) {
  const validUserIds = new Set(db.prepare('SELECT id FROM users').all().map(row => String(row.id)));
  const fallbackKey = String(fallbackUserId ?? '');
  if (!fallbackKey || !validUserIds.has(fallbackKey)) {
    const error = new Error('当前导入管理员账号无效，无法恢复备份');
    error.statusCode = 403;
    throw error;
  }

  let metadataCount = 0;
  for (const table of METADATA_TABLES) {
    const columns = userReferenceColumns(db, table);
    for (const row of metadata[table] || []) {
      for (const column of columns) {
        const value = row[column];
        if (value === null || value === undefined || value === '') continue;
        if (!validUserIds.has(String(value))) {
          row[column] = fallbackUserId;
          metadataCount += 1;
        }
      }
    }
  }

  let workspaceCount = 0;
  const pending = [workspaceState];
  const visited = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach(item => pending.push(item));
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (WORKSPACE_USER_REFERENCE_KEYS.has(key) && child !== null && child !== undefined && child !== '') {
        if (!validUserIds.has(String(child))) {
          value[key] = fallbackUserId;
          workspaceCount += 1;
        }
      } else pending.push(child);
    }
  }

  return { metadataCount, workspaceCount, total: metadataCount + workspaceCount };
}

function insertRows(db, table, rows, teamId) {
  const allowed = tableColumns(db, table);
  for (const source of rows || []) {
    const row = { ...source, team_id: teamId };
    delete row.archive_path;
    const columns = Object.keys(row).filter(column => allowed.has(column));
    if (!columns.length) continue;
    const placeholders = columns.map(() => '?').join(',');
    db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`)
      .run(...columns.map(column => row[column]));
  }
}

async function extractBackupFiles(entries, rows, extracted, { archiveKey = 'archive_path', targetRoot, pathKey, prefix }) {
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const row of rows || []) {
    if (!row[archiveKey]) continue;
    const archivePath = safeArchivePath(row[archiveKey]);
    const entry = entries.get(archivePath);
    if (!entry || entry.type === 'Directory') throw new Error(`备份缺少文件：${archivePath}`);
    const extension = path.extname(row.file_name || row.original_name || archivePath).slice(0, 20);
    const finalPath = path.join(targetRoot, `${prefix}-${row.id}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`);
    extracted.push(finalPath);
    await pipeline(entry.stream(), fs.createWriteStream(finalPath, { flags: 'wx' }));
    if (Number(row.byte_size || row.size_bytes || 0) > 0 && fs.statSync(finalPath).size !== Number(row.byte_size || row.size_bytes)) {
      throw new Error(`备份文件大小校验失败：${archivePath}`);
    }
    row[pathKey] = finalPath;
  }
}

function existingTeamFiles(db, teamId) {
  const files = [];
  for (const [table, key, root] of [
    ['materials_files', 'storage_path', MATERIALS_DIR],
    ['customer_evidence', 'file_path', EVIDENCE_DIR]
  ]) {
    activeRows(db, table, teamId).forEach(row => {
      const value = allowedFilePath(row[key], root);
      if (value) files.push(value);
    });
  }
  return [...new Set(files)];
}

function removeFiles(files) {
  for (const file of files || []) {
    try { fs.rmSync(file, { force: true }); } catch (_) { /* leave orphaned files for manual cleanup */ }
  }
}

function archiveRowsBytes(entries, rows) {
  return (rows || []).reduce((total, row) => {
    if (!row.archive_path) return total;
    const entry = entries.get(safeArchivePath(row.archive_path));
    return total + Number(entry?.uncompressedSize || 0);
  }, 0);
}

function ensureRestoreDiskSpace(entries, metadata) {
  fs.mkdirSync(MATERIALS_DIR, { recursive: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const targets = [
    { root: MATERIALS_DIR, bytes: archiveRowsBytes(entries, metadata.materials_files) },
    { root: EVIDENCE_DIR, bytes: archiveRowsBytes(entries, metadata.customer_evidence) }
  ];
  const byDevice = new Map();
  for (const target of targets) {
    const device = String(fs.statSync(target.root).dev);
    const current = byDevice.get(device) || { root: target.root, bytes: 0 };
    current.bytes += target.bytes;
    byDevice.set(device, current);
  }
  for (const target of byDevice.values()) {
    const stats = fs.statfsSync(target.root);
    const available = Number(stats.bavail) * Number(stats.bsize);
    const reserve = Math.max(MIN_FREE_DISK_RESERVE, Math.ceil(target.bytes * 0.05));
    if (!Number.isFinite(available) || available < target.bytes + reserve) {
      const error = new Error('服务器可用磁盘空间不足，无法完整恢复该备份，原数据未修改');
      error.statusCode = 507;
      throw error;
    }
  }
}

async function restoreFullBackup(db, req, zipPath) {
  const directory = await unzipper.Open.file(zipPath);
  const entries = new Map();
  for (const entry of directory.files) {
    const name = safeArchivePath(entry.path);
    if (entries.has(name)) throw new Error(`备份包含重复路径：${name}`);
    entries.set(name, entry);
  }
  const manifest = await readJsonEntry(entries, 'manifest.json');
  const workspace = await readJsonEntry(entries, 'workspace.json');
  const metadata = await readJsonEntry(entries, 'metadata.json');
  if (manifest.type !== 'zhixun-full-backup' || Number(manifest.formatVersion) !== 1) throw new Error('不是受支持的志询完整备份');
  if (String(manifest.team?.code || '') !== String(req.team.code || '')) throw new Error('备份所属团队与当前团队不一致');
  if (Array.isArray(manifest.missingFiles) && manifest.missingFiles.length) throw new Error('该备份生成时已有资料或附件缺失，不能用于完整恢复');
  if (!workspace.state || typeof workspace.state !== 'object' || Array.isArray(workspace.state)) throw new Error('工作区数据无效');
  for (const table of METADATA_TABLES) if (!Array.isArray(metadata[table])) throw new Error(`备份元数据缺少 ${table}`);
  const remappedUserReferences = remapMissingUserReferences(db, metadata, workspace.state, req.user.id);
  ensureRestoreDiskSpace(entries, metadata);

  const extracted = [];
  const oldFiles = existingTeamFiles(db, req.team.id);
  try {
    await extractBackupFiles(entries, metadata.materials_files, extracted, {
      targetRoot: MATERIALS_DIR, pathKey: 'storage_path', prefix: `restore-material-${req.team.id}`
    });
    await extractBackupFiles(entries, metadata.customer_evidence, extracted, {
      targetRoot: EVIDENCE_DIR, pathKey: 'file_path', prefix: `restore-evidence-${req.team.id}`
    });
    const events = [];
    let version;
    db.transaction(() => {
      DELETE_ORDER.forEach(table => db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).run(req.team.id));
      INSERT_ORDER.forEach(table => insertRows(db, table, metadata[table], req.team.id));
      if (manifest.team?.priorityConfig !== undefined) {
        db.prepare('UPDATE teams SET priority_config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(manifest.team.priorityConfig, req.team.id);
      }
      const current = db.prepare('SELECT version FROM workspace_states WHERE team_id = ?').get(req.team.id);
      version = Number(current?.version || 0) + 1;
      db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, initialized_by_user_id = COALESCE(initialized_by_user_id, ?),
        updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
        .run(JSON.stringify(workspace.state), version, req.user.id, req.user.id, req.team.id);
      const requestId = String(req.get?.('X-Request-Id') || `full-restore-${Date.now()}`).slice(0, 100);
      const event = createSyncEvent(db, {
        teamId: req.team.id, entityType: 'workspace', entityId: String(req.team.id), action: 'workspace.updated',
        entityVersion: version, operatorUserId: req.user.id, requestId,
        payload: { source: 'full_backup_restore', requiresSnapshot: true }
      });
      events.push(event);
      db.prepare(`INSERT INTO operation_logs
        (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'workspace', ?, 'workspace.full_backup_restored', ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify({
          backupCreatedAt: manifest.createdAt,
          version,
          remappedUserReferences: remappedUserReferences.total
        }), requestId, req.ip || '', req.get?.('user-agent') || '');
    })();
    removeFiles(oldFiles.filter(file => !extracted.includes(file)));
    return {
      message: '完整备份已恢复',
      version,
      events,
      restoredFiles: extracted.length,
      remappedUserReferences
    };
  } catch (error) {
    removeFiles(extracted);
    throw error;
  }
}

module.exports = {
  METADATA_TABLES,
  restoreFullBackup,
  streamFullBackup
};
