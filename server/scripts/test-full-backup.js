#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const archiver = require('archiver');
const unzipper = require('unzipper');

const serverDir = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixun-full-backup-'));
const port = 3700 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
let output = '';
const child = spawn(process.execPath, ['src/index.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(port),
    JWT_SECRET: 'full-backup-test-secret',
    ADMIN_DEFAULT_PASSWORD: 'demo123',
    ZHIXUN_DATA_DIR: tempDir,
    ZHIXUN_DB_PATH: path.join(tempDir, 'zhixun.db'),
    ZHIXUN_MATERIALS_DIR: path.join(tempDir, 'materials'),
    ZHIXUN_CUSTOMER_EVIDENCE_DIR: path.join(tempDir, 'customer-evidence'),
    ZHIXUN_BACKUP_UPLOAD_DIR: path.join(tempDir, 'backup-uploads'),
    NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', chunk => { output += chunk.toString(); });
child.stderr.on('data', chunk => { output += chunk.toString(); });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForEmptyDirectory(directory, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.readdirSync(directory).length === 0) return;
    await sleep(25);
  }
  assert.equal(fs.readdirSync(directory).length, 0, '备份临时上传文件应被清理');
}

async function waitForServer() {
  for (let i = 0; i < 300; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch (_) {}
    if (child.exitCode !== null) throw new Error(`测试服务提前退出\n${output}`);
    await sleep(100);
  }
  throw new Error(`测试服务启动超时\n${output}`);
}

async function jsonApi(token, method, endpoint, body, expectedStatus) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else payload = body;
  const response = await fetch(`${base}${endpoint}`, { method, headers, body: payload });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  if (expectedStatus === undefined) assert.ok(response.ok, `${method} ${endpoint} -> ${response.status}: ${text}`);
  else assert.equal(response.status, expectedStatus, `${method} ${endpoint}: ${text}`);
  return data;
}

async function waitForQueueJob(token, jobId, expectedStatus, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await jsonApi(token, 'GET', `/api/sync/jobs/${encodeURIComponent(jobId)}`);
    if (status.status === expectedStatus) return status;
    if (['completed', 'failed'].includes(status.status)) {
      assert.equal(status.status, expectedStatus, `后台备份任务状态异常：${JSON.stringify(status)}`);
    }
    await sleep(50);
  }
  throw new Error(`等待后台备份任务 ${jobId} 超时`);
}

async function stopServer() {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 30 && child.exitCode === null; i += 1) await sleep(50);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function createZip(entries) {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('data', chunk => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    entries.forEach(entry => archive.append(entry.buffer, { name: entry.name }));
    archive.finalize().catch(reject);
  });
}

(async () => {
  try {
    await waitForServer();
    const admin = await jsonApi(null, 'POST', '/api/auth/login', { username: 'demo', password: 'demo123' });
    const token = admin.token;
    const state = {
      version: 2,
      customers: [{ id: 'backup-customer-1', name: '备份客户', sales_status: '新客户', approval: '正式' }],
      tasks: [], feedback: [], chats: [], captures: [], scripts: [],
      experiences: [{ id: 'backup-experience-1', title: '备份经验', content: '恢复后应存在' }],
      materials: [], logs: [], statuses: [{ id: 'status-1', name: '新客户', color: '#315efb' }],
      settings: { priorityConfig: { weights: { followers: 40, evidence: 30, status: 30 } } }
    };
    await jsonApi(token, 'POST', '/api/sync/bootstrap', { state });

    const materialForm = new FormData();
    materialForm.append('category', '资料文件');
    materialForm.append('files', new Blob(['material-before-backup'], { type: 'text/plain' }), 'backup-material.txt');
    const material = (await jsonApi(token, 'POST', '/api/materials/upload', materialForm)).data[0];
    const largePayload = crypto.randomBytes(6 * 1024 * 1024);
    const largeMaterialForm = new FormData();
    largeMaterialForm.append('category', '资料文件');
    largeMaterialForm.append('files', new Blob([largePayload], { type: 'application/zip' }), 'large-backup.zip');
    await jsonApi(token, 'POST', '/api/materials/upload', largeMaterialForm);
    await jsonApi(token, 'PUT', '/api/knowledge/experience/backup-experience-1/relations', {
      relations: [{ targetType: 'material', targetId: String(material.id) }]
    });
    const evidencePayload = Buffer.from('evidence-before-backup').toString('base64');
    const evidence = await jsonApi(token, 'POST', '/api/customers/backup-customer-1/evidence', {
      fileName: 'backup-evidence.png',
      dataUrl: `data:image/png;base64,${evidencePayload}`
    });
    assert.equal(evidence.count, 1);
    await jsonApi(token, 'GET', '/api/sales-statuses');

    const exportResponse = await fetch(`${base}/api/backups/export`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('content-type') || '', /application\/zip/);
    const backupBuffer = Buffer.from(await exportResponse.arrayBuffer());
    assert.ok(backupBuffer.length > 5 * 1024 * 1024, '完整备份应超过普通 JSON 同步请求的 5MB 上限');
    const archive = await unzipper.Open.buffer(backupBuffer);
    const archiveNames = new Set(archive.files.map(entry => entry.path));
    assert.ok(archiveNames.has('manifest.json'));
    assert.ok(archiveNames.has('workspace.json'));
    assert.ok(archiveNames.has('metadata.json'));
    assert.ok([...archiveNames].some(name => name.startsWith('files/materials/')));
    assert.ok([...archiveNames].some(name => name.startsWith('files/customer-evidence/')));

    const missingUserId = 987654321;
    const missingUserEntries = [];
    for (const entry of archive.files) {
      let buffer = await entry.buffer();
      if (entry.path === 'metadata.json') {
        const metadata = JSON.parse(buffer.toString('utf8'));
        metadata.materials_files[0].user_id = missingUserId;
        metadata.materials_files[0].created_by_user_id = missingUserId;
        metadata.sales_statuses[0].updated_by_user_id = missingUserId;
        metadata.customer_evidence[0].deleted_by_user_id = missingUserId;
        buffer = Buffer.from(JSON.stringify(metadata));
      } else if (entry.path === 'workspace.json') {
        const workspace = JSON.parse(buffer.toString('utf8'));
        workspace.state.customers[0].userId = missingUserId;
        workspace.state.customers[0].statusHistory = [{ operatorUserId: missingUserId }];
        buffer = Buffer.from(JSON.stringify(workspace));
      }
      missingUserEntries.push({ name: entry.path, buffer });
    }
    const missingUserBackup = await createZip(missingUserEntries);

    const evidenceArchivePath = [...archiveNames].find(name => name.startsWith('files/customer-evidence/'));
    const corruptEntries = [];
    for (const entry of archive.files) {
      if (entry.path !== evidenceArchivePath) corruptEntries.push({ name: entry.path, buffer: await entry.buffer() });
    }
    const corruptBackup = await createZip(corruptEntries);
    const materialFilesBefore = fs.readdirSync(path.join(tempDir, 'materials')).length;
    const evidenceFilesBefore = fs.readdirSync(path.join(tempDir, 'customer-evidence')).length;
    const corruptRestoreForm = new FormData();
    corruptRestoreForm.append('backup', new Blob([corruptBackup], { type: 'application/zip' }), 'corrupt-backup.zip');
    const corruptAccepted = await jsonApi(token, 'POST', '/api/backups/restore', corruptRestoreForm, 202);
    assert.equal(corruptAccepted.serverPersisted, true);
    const corruptResult = await waitForQueueJob(token, corruptAccepted.jobId, 'failed');
    assert.match(corruptResult.lastError, /备份缺少文件/);
    assert.equal(fs.readdirSync(path.join(tempDir, 'materials')).length, materialFilesBefore, '失败恢复不得残留资料文件');
    assert.equal(fs.readdirSync(path.join(tempDir, 'customer-evidence')).length, evidenceFilesBefore, '失败恢复不得残留客户附件');
    await waitForEmptyDirectory(path.join(tempDir, 'backup-uploads'));
    assert.equal((await jsonApi(token, 'GET', '/api/sync/snapshot')).state.customers[0].name, '备份客户');

    await jsonApi(token, 'DELETE', `/api/materials/${material.id}`);
    await jsonApi(token, 'DELETE', `/api/customers/backup-customer-1/evidence/${evidence.items[0].id}`);
    const changedSnapshot = await jsonApi(token, 'GET', '/api/sync/snapshot');
    changedSnapshot.state.customers[0].name = '恢复前被修改';
    await jsonApi(token, 'PUT', '/api/sync/state', {
      state: changedSnapshot.state,
      baseVersion: changedSnapshot.version
    });

    const restoreForm = new FormData();
    restoreForm.append('backup', new Blob([missingUserBackup], { type: 'application/zip' }), 'full-backup.zip');
    const restoreAccepted = await jsonApi(token, 'POST', '/api/backups/restore', restoreForm, 202);
    assert.equal(restoreAccepted.serverPersisted, true);
    const restored = await waitForQueueJob(token, restoreAccepted.jobId, 'completed');
    assert.equal(restored.restoredFiles, 3);
    assert.equal(restored.remappedUserReferences.metadataCount, 4);
    assert.equal(restored.remappedUserReferences.workspaceCount, 2);
    const restoredSnapshot = await jsonApi(token, 'GET', '/api/sync/snapshot');
    assert.equal(restoredSnapshot.state.customers[0].name, '备份客户');
    assert.equal(String(restoredSnapshot.state.customers[0].userId), String(admin.user.id));
    assert.equal(String(restoredSnapshot.state.customers[0].statusHistory[0].operatorUserId), String(admin.user.id));
    const restoredMaterials = (await jsonApi(token, 'GET', '/api/materials')).data;
    assert.equal(restoredMaterials.length, 2);
    const restoredTextMaterial = restoredMaterials.find(item => item.original_name === 'backup-material.txt');
    const restoredLargeMaterial = restoredMaterials.find(item => item.original_name === 'large-backup.zip');
    assert.ok(restoredTextMaterial);
    assert.ok(restoredLargeMaterial);
    const materialDownload = await fetch(`${base}/api/materials/${restoredTextMaterial.id}/download`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(await materialDownload.text(), 'material-before-backup');
    const largeDownload = await fetch(`${base}/api/materials/${restoredLargeMaterial.id}/download`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual(Buffer.from(await largeDownload.arrayBuffer()), largePayload);
    await waitForEmptyDirectory(path.join(tempDir, 'backup-uploads'));
    const restoredEvidence = await jsonApi(token, 'GET', '/api/customers/backup-customer-1/evidence');
    assert.equal(restoredEvidence.count, 1);
    const restoredRelations = await jsonApi(token, 'GET', '/api/knowledge/relations');
    assert.equal(restoredRelations.data.length, 1);
    const logs = await jsonApi(token, 'GET', '/api/operation-logs?scope=mine&page=1&limit=10');
    assert.ok(logs.data.some(item => item.action === 'workspace.full_backup_restored'));
    const authSource = fs.readFileSync(path.join(serverDir, '..', 'client', 'auth-helper.js'), 'utf8');
    const capturedRequests = [];
    const authContext = {
      FormData,
      URLSearchParams,
      JSON,
      atob,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      fetch: async (_url, options) => {
        capturedRequests.push(options);
        return { status: 200 };
      },
      window: { location: { href: '' } }
    };
    vm.runInNewContext(authSource, authContext);
    await authContext.window.ZhiXunAuth.fetch('/form-data-check', { method: 'POST', body: new FormData() });
    await authContext.window.ZhiXunAuth.fetch('/json-check', { method: 'POST', body: '{}' });
    const contentType = options => Object.entries(options.headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    assert.equal(contentType(capturedRequests[0]), undefined, 'FormData 请求不得默认标记为 JSON');
    assert.equal(contentType(capturedRequests[1]), 'application/json', '普通 API 请求仍应默认使用 JSON');
    const oneStopSource = fs.readFileSync(path.join(serverDir, '..', 'client', 'one-stop.js'), 'utf8');
    const closeFunctionSource = oneStopSource.match(/^function scheduleBackupRestoreProgressClose\(\)\{.*\}$/m)?.[0];
    assert.ok(closeFunctionSource, '应保留备份恢复成功后的进度条自动关闭逻辑');
    let timeoutCallback;
    const closeContext = {
      backupRestoreHideTimer: null,
      backupRestoreState: { visible: true, running: false, progress: 100, fileName: 'backup.zip', error: '' },
      clearTimeout: () => {},
      setTimeout: callback => { timeoutCallback = callback; return 1; },
      removed: 0
    };
    closeContext.$ = () => ({ remove: () => { closeContext.removed += 1; } });
    vm.runInNewContext(closeFunctionSource, closeContext);
    closeContext.scheduleBackupRestoreProgressClose();
    timeoutCallback();
    assert.equal(closeContext.backupRestoreState.visible, false, '恢复成功后应自动隐藏进度条');
    assert.equal(closeContext.removed, 1, '恢复成功后应移除进度条节点');
    closeContext.backupRestoreState = { visible: true, running: false, progress: 0, fileName: 'backup.zip', error: '恢复失败' };
    closeContext.removed = 0;
    closeContext.scheduleBackupRestoreProgressClose();
    timeoutCallback();
    assert.equal(closeContext.backupRestoreState.visible, true, '恢复失败时应保留错误进度条');
    assert.equal(closeContext.removed, 0, '恢复失败时不应移除错误提示');
    console.log('Full backup integration checks passed.');
  } finally {
    await stopServer();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error);
  if (output) console.error(output);
  process.exitCode = 1;
});
