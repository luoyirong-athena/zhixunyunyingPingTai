#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const serverDir = path.resolve(__dirname, '..');
const CONFIRMATION = '确认清空全部业务数据';

function assertBrowserDoesNotPersistFullStateSnapshots() {
  const clientSource = fs.readFileSync(path.resolve(serverDir, '..', 'client', 'one-stop.js'), 'utf8');
  assert.match(clientSource, /function clearLocalFullStateBackups\(\)/, '前端应提供旧快照清理逻辑');
  assert.doesNotMatch(clientSource, /localStorage\.setItem\(STORAGE_KEY\+'_before_reset_'/, '清空业务数据不得把完整状态写入浏览器缓存');
  assert.doesNotMatch(clientSource, /localStorage\.setItem\(STORAGE_KEY\+'_before_restore_'/, '导入备份不得额外保存完整状态快照');
  assert.doesNotMatch(clientSource, /localStorage\.setItem\(LEGACY_KEY\+'_backup_'/, '旧数据迁移不得保存完整状态快照');
  assert.doesNotMatch(clientSource, /localStorage\.setItem\(backupKey/, '团队同步初始化不得保存完整状态快照');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function startServer({ tempDir, backupDir }) {
  const dbPath = path.join(tempDir, 'zhixun.db');
  const evidenceDir = path.join(tempDir, 'customer-evidence');
  const materialsDir = path.join(tempDir, 'materials');
  const port = 3300 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: 'business-data-reset-integration-test-secret',
      ADMIN_DEFAULT_PASSWORD: 'demo123',
      ZHIXUN_DATA_DIR: tempDir,
      ZHIXUN_DB_PATH: dbPath,
      ZHIXUN_BACKUP_DIR: backupDir,
      ZHIXUN_CUSTOMER_EVIDENCE_DIR: evidenceDir,
      ZHIXUN_MATERIALS_DIR: materialsDir,
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    for (let i = 0; i < 100; i += 1) {
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok) return { child, base, dbPath, evidenceDir, materialsDir, output: () => output };
      } catch (_) {}
      if (child.exitCode !== null) throw new Error(`测试服务提前退出\n${output}`);
      await sleep(100);
    }
    throw new Error(`测试服务启动超时\n${output}`);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 30 && child.exitCode === null; i += 1) await sleep(50);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function api(base, token, method, endpoint, body, expectedStatus) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${base}${endpoint}`, { method, headers, body: payload });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  if (expectedStatus === undefined) {
    assert.ok(response.ok, `${method} ${endpoint} -> ${response.status}: ${text}`);
  } else {
    assert.equal(response.status, expectedStatus, `${method} ${endpoint}: ${text}`);
  }
  return { response, data };
}

async function login(base, username, password) {
  return (await api(base, null, 'POST', '/api/auth/login', { username, password })).data;
}

async function register(base, username) {
  return (await api(base, null, 'POST', '/api/auth/register', {
    username,
    password: 'portfolio-member-pass-123',
    confirm_password: 'portfolio-member-pass-123',
    display_name: username
  })).data;
}

function seedBusinessData({ dbPath, evidenceDir, materialsDir, memberUsername = 'reset-member' }) {
  const db = new Database(dbPath);
  const team = db.prepare("SELECT id FROM teams WHERE code='operations-default'").get();
  const admin = db.prepare("SELECT id FROM users WHERE username='demo'").get();
  const member = db.prepare('SELECT id FROM users WHERE username = ?').get(memberUsername);
  assert.ok(team && admin && member);
  const teamId = team.id;
  const userId = admin.id;

  const customer = db.prepare(`INSERT INTO customers
    (user_id, team_id, created_by_user_id, updated_by_user_id, version, name, phone, sales_status, approval_status, province)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
    userId, teamId, userId, userId, '待清空客户', '13900000001', '高意向', '正式', '广东'
  );
  const customerId = customer.lastInsertRowid;

  db.prepare(`INSERT INTO tasks (user_id, team_id, created_by_user_id, updated_by_user_id, version, customer_id, title)
    VALUES (?, ?, ?, ?, 1, ?, ?)`).run(userId, teamId, userId, userId, customerId, '待清空任务');
  const feedback = db.prepare(`INSERT INTO feedback (user_id, team_id, created_by_user_id, updated_by_user_id, version, customer_id, customer_name, content)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(userId, teamId, userId, userId, customerId, '待清空客户', '待清空反馈');
  db.prepare(`INSERT INTO chat_records (user_id, team_id, created_by_user_id, updated_by_user_id, version, customer_id, file_name, messages)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(userId, teamId, userId, userId, customerId, 'chat.json', '[]');
  db.prepare(`INSERT INTO customer_status_history (user_id, team_id, created_by_user_id, updated_by_user_id, version, customer_id, operator_user_id, from_status, to_status)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(userId, teamId, userId, userId, customerId, userId, '新客户', '高意向');
  db.prepare(`INSERT INTO workspace_customer_status_history
    (team_id, customer_id, user_id, operator_user_id, from_status, to_status, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(teamId, String(customerId), userId, userId, '新客户', '高意向', 'reset-history-1');
  db.prepare(`INSERT INTO customer_data_permissions
    (team_id, customer_id, owner_user_id, requester_user_id, status)
    VALUES (?, ?, ?, ?, ?)`).run(teamId, String(customerId), userId, member.id, 'pending');
  db.prepare(`INSERT INTO tags (user_id, team_id, created_by_user_id, updated_by_user_id, version, name, category)
    VALUES (?, ?, ?, ?, 1, ?, ?)`).run(userId, teamId, userId, userId, '客户标签', '客户');
  db.prepare(`INSERT INTO product_requests (user_id, team_id, created_by_user_id, updated_by_user_id, version, title, status)
    VALUES (?, ?, ?, ?, 1, ?, ?)`).run(userId, teamId, userId, userId, '保留的产品需求', '规划中');

  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, 'customer-proof.png');
  fs.writeFileSync(evidencePath, 'customer evidence');
  db.prepare(`INSERT INTO customer_evidence
    (team_id, customer_id, evidence_type, file_name, mime_type, file_path, byte_size, created_by_user_id, updated_by_user_id, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(teamId, String(customerId), 'moments_order_screenshot', 'customer-proof.png', 'image/png', evidencePath, 16, userId, userId);

  fs.mkdirSync(materialsDir, { recursive: true });
  const customerMaterialPath = path.join(materialsDir, 'customer-attachment.txt');
  const experienceMaterialPath = path.join(materialsDir, 'experience-material.txt');
  fs.writeFileSync(customerMaterialPath, 'customer attachment');
  fs.writeFileSync(experienceMaterialPath, 'experience material');
  const insertMaterial = db.prepare(`INSERT INTO materials_files
    (user_id, team_id, created_by_user_id, updated_by_user_id, version, original_name, stored_name, mime_type, extension, size_bytes, storage_path, category)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`);
  const customerMaterial = insertMaterial.run(userId, teamId, userId, userId, 'customer-attachment.txt', 'customer-attachment.txt', 'text/plain', 'txt', 18, customerMaterialPath, '客户附件');
  const experienceMaterial = insertMaterial.run(userId, teamId, userId, userId, 'experience-material.txt', 'experience-material.txt', 'text/plain', 'txt', 17, experienceMaterialPath, '经验素材');
  db.prepare(`INSERT INTO materials_jobs
    (user_id, team_id, created_by_user_id, updated_by_user_id, version, material_id, job_type, status)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(userId, teamId, userId, userId, customerMaterial.lastInsertRowid, 'extract', 'queued');
  db.prepare(`INSERT INTO knowledge_relations
    (team_id, source_type, source_id, target_type, target_id, relation_type, created_by_user_id, updated_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(teamId, 'customer', String(customerId), 'material', String(customerMaterial.lastInsertRowid), 'reference', userId, userId);
  db.prepare(`INSERT INTO knowledge_relations
    (team_id, source_type, source_id, target_type, target_id, relation_type, created_by_user_id, updated_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(teamId, 'experience', 'experience-1', 'material', String(experienceMaterial.lastInsertRowid), 'reference', userId, userId);

  db.prepare(`INSERT INTO experiences
    (user_id, team_id, created_by_user_id, updated_by_user_id, version, title, content, category, tags)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`)
    .run(userId, teamId, userId, userId, '保留的经验', '经验内容', '经验中心', '[]');
  db.prepare(`INSERT INTO sales_statuses (user_id, team_id, created_by_user_id, updated_by_user_id, version, name, color)
    VALUES (?, ?, ?, ?, 1, ?, ?)`)
    .run(userId, teamId, userId, userId, '保留状态', '#315efb');
  db.prepare(`INSERT INTO operation_logs
    (team_id, operator_user_id, entity_type, entity_id, action, before_data, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(teamId, userId, 'test', 'before-reset', '保留旧日志', '{}', 'before-reset-1');
  db.prepare(`INSERT INTO sync_events
    (event_id, team_id, entity_type, entity_id, action, entity_version, operator_user_id, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('old-event', teamId, 'customer', String(customerId), 'customer.created', 1, userId, 'old-event-1');

  const state = {
    version: 2,
    dataVersionName: '本地测试数据',
    customers: [{ id: String(customerId), name: '待清空客户' }],
    tasks: [{ id: 'task-state-1', title: '待清空任务' }],
    feedback: [{ id: 'feedback-state-1', content: '待清空反馈' }],
    chats: [{ id: 'chat-state-1' }],
    captures: [{ id: 'capture-1' }],
    captureSession: { id: 'session-1' },
    duplicateResolutions: [{ id: 'duplicate-1' }],
    scripts: [{ id: 'script-1', title: '保留话术' }],
    experiences: [{ id: 'experience-1', title: '保留的经验' }],
    materials: [{ id: String(experienceMaterial.lastInsertRowid), name: '保留素材' }],
    settings: { api: { provider: 'test', apiKey: 'keep-me' } },
    statuses: [{ name: '保留状态' }],
    logs: [{ id: 'old-state-log', action: '旧日志', detail: '保留' }]
  };
  db.prepare('UPDATE workspace_states SET state_json = ?, version = ?, updated_by_user_id = ? WHERE team_id = ?')
    .run(JSON.stringify(state), 7, userId, teamId);
  db.close();
  return { teamId, customerId, customerMaterialId: customerMaterial.lastInsertRowid, experienceMaterialId: experienceMaterial.lastInsertRowid, feedbackId: feedback.lastInsertRowid, userId, memberId: member.id };
}

function count(db, table, teamId) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE team_id = ?`).get(teamId)?.count || 0);
}

async function runSuccessScenario() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixun-reset-success-'));
  const backupDir = path.join(tempDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const server = await startServer({ tempDir, backupDir });
  try {
    const admin = await login(server.base, 'admin', 'demo123');
    await register(server.base, 'reset-member');
    const member = await login(server.base, 'reset-member', 'portfolio-member-pass-123');
    const seeded = seedBusinessData(server);

    await api(server.base, member.token, 'POST', '/api/data/reset', { confirmation: CONFIRMATION, requestId: 'member-reset-1' }, 403);
    await api(server.base, admin.token, 'POST', '/api/data/reset', { confirmation: '错误确认', requestId: 'wrong-confirmation-1' }, 400);
    let db = new Database(server.dbPath);
    assert.equal(count(db, 'customers', seeded.teamId), 1, '错误确认不得清空客户');
    db.close();

    const reset = await api(server.base, admin.token, 'POST', '/api/data/reset', { confirmation: CONFIRMATION, requestId: 'business-reset-test-1' });
    assert.equal(reset.data.message, '业务数据已清空，经验中心及系统配置已保留');
    assert.equal(reset.data.backup.name.startsWith('business-reset-'), true);

    db = new Database(server.dbPath);
    for (const table of ['customers', 'tasks', 'feedback', 'chat_records', 'customer_status_history', 'workspace_customer_status_history', 'customer_evidence', 'customer_data_permissions', 'tags', 'knowledge_relations', 'materials_jobs']) {
      if (table === 'materials_jobs' || table === 'knowledge_relations') {
        // checked separately below because experience-center rows are retained
        continue;
      }
      assert.equal(count(db, table, seeded.teamId), 0, `${table} 应清空`);
    }
    assert.equal(count(db, 'product_requests', seeded.teamId), 1, '独立产品需求不应被误删');
    assert.equal(count(db, 'experiences', seeded.teamId), 1, '经验中心经验应保留');
    assert.equal(count(db, 'sales_statuses', seeded.teamId), 1, '销售状态配置应保留');
    assert.equal(count(db, 'materials_files', seeded.teamId), 1, '客户附件删除后应保留经验素材');
    assert.equal(count(db, 'materials_jobs', seeded.teamId), 0, '客户关联资料任务应清空');
    assert.equal(count(db, 'knowledge_relations', seeded.teamId), 1, '经验中心关联关系应保留');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE id IN (?, ?)").get(seeded.userId, seeded.memberId).count, 2, '用户账号应保留');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE team_id = ? AND action = '保留旧日志'").get(seeded.teamId).count, 1, '旧操作日志应保留');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE team_id = ? AND action = 'business_data_cleared'").get(seeded.teamId).count, 1, '清理操作日志应写入');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sync_events WHERE team_id = ? AND action = 'workspace.business_data_cleared'").get(seeded.teamId).count, 1, '清理同步事件应写入');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const stateRow = db.prepare('SELECT state_json, version FROM workspace_states WHERE team_id = ?').get(seeded.teamId);
    const state = JSON.parse(stateRow.state_json);
    assert.equal(state.customers.length, 0);
    assert.equal(state.tasks.length, 0);
    assert.equal(state.captures.length, 0);
    assert.deepEqual(state.captureSession, {});
    assert.equal(state.duplicateResolutions.length, 0);
    assert.equal(state.dataVersionName, '');
    assert.equal(state.settings.api.apiKey, 'keep-me');
    assert.equal(state.experiences[0].title, '保留的经验');
    assert.equal(state.scripts[0].title, '保留话术');
    assert.ok(state.logs.some(log => log.action === '清空业务数据'));
    assert.equal(stateRow.version, 8);
    db.close();

    assert.equal(fs.existsSync(path.join(server.evidenceDir, 'customer-proof.png')), false, '客户证据文件应删除');
    assert.equal(fs.existsSync(path.join(server.materialsDir, 'customer-attachment.txt')), false, '客户附件应删除');
    assert.equal(fs.existsSync(path.join(server.materialsDir, 'experience-material.txt')), true, '经验素材文件应保留');

    const backupNames = fs.readdirSync(backupDir).filter(name => name.startsWith('business-reset-'));
    assert.equal(backupNames.length, 1, '应生成一份清理前备份');
    const backupPath = path.join(backupDir, backupNames[0]);
    assert.ok(fs.existsSync(path.join(backupPath, 'zhixun.db')));
    assert.ok(fs.existsSync(path.join(backupPath, 'manifest.json')));
    const backupDb = new Database(path.join(backupPath, 'zhixun.db'), { readonly: true });
    assert.equal(count(backupDb, 'customers', seeded.teamId), 1, '备份中应保留清理前客户');
    assert.equal(backupDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    backupDb.close();

    const snapshot = await api(server.base, admin.token, 'GET', '/api/sync/snapshot');
    assert.equal(snapshot.data.state.customers.length, 0);
    const changes = await api(server.base, admin.token, 'GET', '/api/sync/changes?cursor=0');
    assert.ok(changes.data.events.some(event => event.action === 'workspace.business_data_cleared'));

    const idempotent = await api(server.base, admin.token, 'POST', '/api/data/reset', { confirmation: CONFIRMATION, requestId: 'business-reset-test-1' });
    assert.equal(idempotent.data.idempotent, true, '重复 requestId 应幂等返回');
    assert.equal(fs.readdirSync(backupDir).filter(name => name.startsWith('business-reset-')).length, 1, '幂等重试不得重复备份');
  } finally {
    await stopServer(server.child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runBackupFailureScenario() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixun-reset-backup-failure-'));
  const backupFile = path.join(tempDir, 'backup-target');
  fs.writeFileSync(backupFile, 'not a directory');
  const server = await startServer({ tempDir, backupDir: backupFile });
  try {
    const admin = await login(server.base, 'admin', 'demo123');
    await register(server.base, 'backup-member');
    const seeded = seedBusinessData({ ...server, memberUsername: 'backup-member' });
    const result = await api(server.base, admin.token, 'POST', '/api/data/reset', { confirmation: CONFIRMATION, requestId: 'backup-failure-1' }, 500);
    assert.match(String(result.data.error), /备份失败/);
    const db = new Database(server.dbPath);
    assert.equal(count(db, 'customers', seeded.teamId), 1, '备份失败时不得清空客户');
    assert.equal(count(db, 'tasks', seeded.teamId), 1, '备份失败时不得清空任务');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE team_id = ? AND action = 'business_data_cleared'").get(seeded.teamId).count, 0);
    db.close();
  } finally {
    await stopServer(server.child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

(async () => {
  try {
    assertBrowserDoesNotPersistFullStateSnapshots();
    await runSuccessScenario();
    await runBackupFailureScenario();
    console.log('business-data-reset integration tests passed');
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
})();
