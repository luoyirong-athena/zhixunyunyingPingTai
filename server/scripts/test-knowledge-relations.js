#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const serverDir = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixun-knowledge-relations-'));
const dbPath = path.join(tempDir, 'test.db');
const materialsDir = path.join(tempDir, 'materials');
const fixtureDir = path.join(tempDir, 'fixtures');
fs.mkdirSync(fixtureDir, { recursive: true });
const port = 3700 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let logs = '';

const child = spawn(process.execPath, ['src/index.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(port),
    JWT_SECRET: 'knowledge-relations-integration-test-secret',
    ADMIN_DEFAULT_PASSWORD: 'demo123',
    ZHIXUN_DB_PATH: dbPath,
    ZHIXUN_MATERIALS_DIR: materialsDir,
    NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    if (child.exitCode !== null) throw new Error(`测试服务提前退出\n${logs}`);
    await sleep(100);
  }
  throw new Error(`测试服务启动超时\n${logs}`);
}

async function api(token, method, endpoint, body, extraHeaders = {}, expectedStatus) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${base}${endpoint}`, { method, headers, body: payload });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  if (expectedStatus !== undefined) {
    assert.equal(response.status, expectedStatus, `${method} ${endpoint}: ${text}`);
  } else {
    assert.ok(response.ok, `${method} ${endpoint} -> ${response.status}: ${text}`);
  }
  return { response, data };
}

async function register(username) {
  return (await api(null, 'POST', '/api/auth/register', {
    username,
    password: 'portfolio-test-pass-123',
    confirm_password: 'portfolio-test-pass-123',
    display_name: username.toUpperCase()
  })).data;
}

function buildSpreadsheetFixture() {
  const rows = [];
  for (let r = 0; r < 205; r += 1) {
    rows.push(Array.from({ length: 55 }, (_, c) => r === 0 ? `列${c + 1}` : `R${r + 1}C${c + 1}`));
  }
  const sheet1 = XLSX.utils.aoa_to_sheet(rows);
  sheet1['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  const sheet2 = XLSX.utils.aoa_to_sheet([['第二工作表'], ['内容']]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet1, '招生计划');
  XLSX.utils.book_append_sheet(workbook, sheet2, '专业目录');
  const filePath = path.join(fixtureDir, '广西招生计划.xlsx');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

async function uploadFile(token, filePath, category) {
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  form.append('files', new Blob([bytes]), path.basename(filePath));
  form.append('category', category);
  return (await api(token, 'POST', '/api/materials/upload', form)).data.data[0];
}

(async () => {
  let db;
  try {
    await waitForServer();
    const alice = await register('knowledge-alice');
    const bob = await register('knowledge-bob');

    const initialState = {
      version: 2,
      customers: [], tasks: [], feedback: [], chats: [], captures: [], logs: [], statuses: [], settings: {}, materials: [],
      scripts: [
        { id: 'script-opening', title: '首次添加微信开场话术', category: '首次联系', scene: '加微信', content: '您好，我是志愿规划顾问。', createdAt: '2026-08-04T00:00:00.000Z', updatedAt: '2026-08-04T00:00:00.000Z' },
        { id: 'script-followup', title: '高意向客户跟进话术', category: '跟进', scene: '高意向', content: '老师您好，继续跟进您的需求。', createdAt: '2026-08-04T00:00:00.000Z', updatedAt: '2026-08-04T00:00:00.000Z' }
      ],
      experiences: [
        { id: 'experience-gx', title: '广西客户沟通经验', category: '高考规划', scene: '首次沟通', content: '先了解客户机构和服务范围。', createdAt: '2026-08-04T00:00:00.000Z', updatedAt: '2026-08-04T00:00:00.000Z' }
      ]
    };
    await api(alice.token, 'POST', '/api/sync/bootstrap', { state: initialState });

    const xlsxPath = buildSpreadsheetFixture();
    const material = await uploadFile(alice.token, xlsxPath, '招生资料');
    assert.equal(material.extension, 'xlsx');

    const csvPath = path.join(fixtureDir, '客户名单.csv');
    fs.writeFileSync(csvPath, '姓名,城市\n张老师,南宁\n李老师,桂林\n', 'utf8');
    const csvMaterial = await uploadFile(alice.token, csvPath, '客户资料');

    const relationBody = {
      relations: [
        { targetType: 'script', targetId: 'script-opening' },
        { targetType: 'script', targetId: 'script-opening' },
        { targetType: 'material', targetId: String(material.id) }
      ]
    };
    const created = (await api(alice.token, 'PUT', '/api/knowledge/experience/experience-gx/relations', relationBody, { 'X-Request-Id': 'knowledge-create-1' })).data.data;
    assert.equal(created.length, 2, '重复关系应去重');

    const allForBob = (await api(bob.token, 'GET', '/api/knowledge/relations')).data.data;
    assert.equal(allForBob.length, 2, '同一团队成员应看到相同关系');
    assert.ok(allForBob.every(row => row.sourceItem?.title === '广西客户沟通经验'));

    const reverseScript = (await api(bob.token, 'GET', '/api/knowledge/script/script-opening/relations')).data;
    assert.equal(reverseScript.data.length, 1);
    assert.equal(reverseScript.data[0].sourceItem.title, '广西客户沟通经验');

    const reverseMaterial = (await api(bob.token, 'GET', `/api/knowledge/material/${material.id}/relations`)).data;
    assert.equal(reverseMaterial.data.length, 1);
    assert.equal(reverseMaterial.data[0].targetItem.title, '广西招生计划.xlsx');

    const catalog = (await api(alice.token, 'GET', '/api/knowledge/catalog?types=script,material&q=%E9%AB%98%E6%84%8F%E5%90%91')).data.data;
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, 'script-followup');

    const sheetPreview = (await api(alice.token, 'GET', `/api/materials/${material.id}/preview?limit=200`)).data;
    assert.equal(sheetPreview.kind, 'spreadsheet');
    assert.deepEqual(sheetPreview.sheets, ['招生计划', '专业目录']);
    assert.equal(sheetPreview.rows.length, 200);
    assert.equal(sheetPreview.columns.length, 50);
    assert.equal(sheetPreview.totalRows, 205);
    assert.equal(sheetPreview.totalColumns, 55);
    assert.equal(sheetPreview.partial, true);
    assert.ok(sheetPreview.merges.some(merge => merge.startRow === 1 && merge.endColumn === 1));

    const secondSheet = (await api(alice.token, 'GET', `/api/materials/${material.id}/preview?sheet=${encodeURIComponent('专业目录')}`)).data;
    assert.equal(secondSheet.activeSheet, '专业目录');
    assert.equal(secondSheet.rows[0].cells[0], '第二工作表');

    const csvPreview = (await api(alice.token, 'GET', `/api/materials/${csvMaterial.id}/preview`)).data;
    assert.equal(csvPreview.kind, 'spreadsheet');
    assert.equal(csvPreview.rows[1].cells[1], '南宁');

    const relationId = created.find(row => row.targetType === 'script').id;
    await api(alice.token, 'DELETE', `/api/knowledge/relations/${relationId}`, undefined, { 'X-Request-Id': 'knowledge-delete-1' });
    const afterDelete = (await api(alice.token, 'GET', '/api/knowledge/relations')).data.data;
    assert.equal(afterDelete.length, 1, '删除关系不得删除其他关系');
    const stateAfterDelete = (await api(alice.token, 'GET', '/api/sync/snapshot')).data.state;
    assert.ok(stateAfterDelete.scripts.some(item => item.id === 'script-opening'), '删除关系不得删除话术');
    assert.ok(stateAfterDelete.experiences.some(item => item.id === 'experience-gx'), '删除关系不得删除经验');
    assert.ok((await api(alice.token, 'GET', `/api/materials/${material.id}/preview`)).data.rows.length > 0, '删除关系不得删除资料');

    const restored = (await api(alice.token, 'PUT', '/api/knowledge/experience/experience-gx/relations', relationBody, { 'X-Request-Id': 'knowledge-restore-1' })).data.data;
    assert.equal(restored.length, 2, '软删除关系应可恢复');

    db = new Database(dbPath);
    const team = db.prepare("SELECT * FROM teams WHERE code='operations-default'").get();
    const bobUser = db.prepare("SELECT * FROM users WHERE username='knowledge-bob'").get();
    db.prepare("UPDATE team_members SET role='viewer' WHERE team_id=? AND user_id=?").run(team.id, bobUser.id);
    await api(bob.token, 'PUT', '/api/knowledge/experience/experience-gx/relations', { relations: [] }, {}, 403);

    const otherTeam = db.prepare("INSERT INTO teams (code, name, status) VALUES ('other-team', '其他团队', 'active')").run().lastInsertRowid;
    const crossTeamMaterial = db.prepare(`INSERT INTO materials_files
      (user_id, team_id, created_by_user_id, updated_by_user_id, version, original_name, stored_name, mime_type, extension, size_bytes, storage_path, category)
      VALUES (?, ?, ?, ?, 1, '跨团队.xlsx', 'cross-team.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', ?, ?, '其他')`)
      .run(alice.user.id, otherTeam, alice.user.id, alice.user.id, fs.statSync(xlsxPath).size, xlsxPath).lastInsertRowid;
    await api(alice.token, 'GET', `/api/materials/${crossTeamMaterial}/preview`, undefined, {}, 404);

    const relationEvents = db.prepare("SELECT action FROM sync_events WHERE team_id=? AND action LIKE 'knowledge.relation%' ORDER BY id").all(team.id);
    assert.ok(relationEvents.some(row => row.action === 'knowledge.relations_updated'));
    assert.ok(relationEvents.some(row => row.action === 'knowledge.relation_deleted'));
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');

    const rowsBeforeReinit = db.prepare('SELECT COUNT(*) AS total FROM knowledge_relations').get().total;
    db.close(); db = null;

    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));

    const reinit = spawn(process.execPath, ['-e', "const db=require('./src/config/database'); db.initDatabase(); console.log(db.getDatabase().pragma('integrity_check',{simple:true})); db.closeDatabase();"], {
      cwd: serverDir,
      env: { ...process.env, ZHIXUN_DB_PATH: dbPath, ZHIXUN_MATERIALS_DIR: materialsDir, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let reinitOutput = '';
    reinit.stdout.on('data', chunk => { reinitOutput += chunk; });
    reinit.stderr.on('data', chunk => { reinitOutput += chunk; });
    const reinitCode = await new Promise(resolve => reinit.once('exit', resolve));
    assert.equal(reinitCode, 0, reinitOutput);
    assert.ok(reinitOutput.includes('ok'));

    db = new Database(dbPath);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM knowledge_relations').get().total, rowsBeforeReinit, '重复迁移不得丢失关系');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');

    console.log(JSON.stringify({
      result: 'ok',
      relations: restored.length,
      sheets: sheetPreview.sheets.length,
      previewRows: sheetPreview.rows.length,
      previewColumns: sheetPreview.columns.length,
      tempDatabase: dbPath
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error);
    if (logs) console.error(`\n--- server logs ---\n${logs}`);
    process.exitCode = 1;
  } finally {
    try { db?.close(); } catch (_) {}
    if (child.exitCode === null) child.kill('SIGTERM');
  }
})();
