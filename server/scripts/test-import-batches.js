#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { normalizeWorkspaceState } = require('../src/services/workspaceState');

const serverDir = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixun-import-batches-'));
const dbPath = path.join(tempDir, 'test.db');
const port = 3600 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
let logs = '';
const child = spawn(process.execPath, ['src/index.js'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(port), JWT_SECRET: 'import-batches-test-secret', ADMIN_DEFAULT_PASSWORD: 'demo123', ZHIXUN_DB_PATH: dbPath, NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer() {
  for (let index = 0; index < 300; index += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch (_) {}
    if (child.exitCode !== null) throw new Error(`测试服务提前退出\n${logs}`);
    await sleep(100);
  }
  throw new Error(`测试服务启动超时\n${logs}`);
}
async function api(token, method, endpoint, body, expectedStatus) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const response = await fetch(`${base}${endpoint}`, { method, headers, body: payload });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  if (expectedStatus === undefined) assert.ok(response.ok, `${method} ${endpoint}: ${response.status} ${text}`);
  else assert.equal(response.status, expectedStatus, `${method} ${endpoint}: ${text}`);
  return data;
}
async function apiWithRequestId(token, method, endpoint, body, requestIdValue) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Request-Id': requestIdValue };
  const response = await fetch(`${base}${endpoint}`, { method, headers, body: JSON.stringify(body) });
  const text = await response.text();
  const data = JSON.parse(text);
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status} ${text}`);
  return data;
}
async function register(username) {
  return api('', 'POST', '/api/auth/register', { username, password: 'portfolio-test-pass-123', confirm_password: 'portfolio-test-pass-123', display_name: username });
}
function customer(id, name, phone, approval = '待确认') {
  return { id, name, province: '四川', city: '成都', sales_status: '新客户', phone, identity: '', approval, statusHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), userId: 2, created_by_user_id: 2 };
}
function capture(id, customerId) { return { id, customerId, name: `采集${customerId}`, created_by_user_id: 2, createdBy: 'alice', created_by_username: 'alice', createdAt: new Date().toISOString() }; }

const cleanupRulesState = normalizeWorkspaceState({
  customers: [
    { id: 'official-customer', approval: '正式' },
    { id: 'pending-customer', approval: '待确认' }
  ],
  captures: [
    capture('official-capture', 'official-customer'),
    { ...capture('confirmed-capture', 'pending-customer'), confirmed: true },
    capture('pending-capture', 'pending-customer'),
    capture('orphan-capture', '')
  ]
});
assert.equal(cleanupRulesState.captures.some(item => item.id === 'official-capture'), false, '已关联正式客户的历史采集记录应清理');
assert.equal(cleanupRulesState.captures.some(item => item.id === 'confirmed-capture'), false, '已确认的历史采集记录应清理');
assert.equal(cleanupRulesState.captures.some(item => item.id === 'pending-capture'), true, '待确认客户的采集记录应保留');
assert.equal(cleanupRulesState.captures.some(item => item.id === 'orphan-capture'), true, '未处理采集记录应保留');

(async () => {
  try {
    await waitForServer();
    const alice = await register('alice');
    const initial = { version: 2, customers: [], tasks: [], feedback: [], chats: [], captures: [], scripts: [], experiences: [], materials: [], logs: [], statuses: [{ id: 'status-new', name: '新客户', color: '#315efb' }], settings: { identities: [] } };
    const bootstrap = await api(alice.token, 'POST', '/api/sync/bootstrap', { state: initial });
    const oversized = await api(alice.token, 'PUT', '/api/sync/state', {
      state: { ...initial, oversized: 'x'.repeat(5 * 1024 * 1024) },
      baseVersion: bootstrap.version
    }, 413);
    assert.equal(oversized.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(oversized.retryable, false);
    const batchCustomers = [customer('import-1', '导入一', '17000000001'), customer('import-2', '导入二', '17000000002')];
    const batchCaptures = [capture('capture-1', 'import-1'), capture('capture-2', 'import-2')];
    const importPayload = { importId: 'import-test', batchIndex: 0, totalBatches: 1, customers: batchCustomers, captures: [batchCaptures[0]], captureMode: 'none' };
    const imported = await api(alice.token, 'POST', '/api/sync/import-batch', importPayload);
    assert.equal(imported.accepted, 2);
    const replayedImport = await api(alice.token, 'POST', '/api/sync/import-batch', importPayload);
    assert.equal(replayedImport.replayed, true);
    assert.equal(replayedImport.accepted, 2);
    const afterCustomerImport = await api(alice.token, 'GET', '/api/sync/snapshot');
    assert.equal(afterCustomerImport.state.captures.some(item => item.customerId === 'import-1'), false, 'Excel 导入不得生成客户采集记录');
    afterCustomerImport.state.captures.push(batchCaptures[0]);
    await api(alice.token, 'PUT', '/api/sync/state', { state: afterCustomerImport.state, baseVersion: afterCustomerImport.version });
    const captureDeletePayload = { importId: 'capture-delete-test', batchIndex: 0, totalBatches: 1, captureIds: ['capture-1'] };
    const deletedCapture = await api(alice.token, 'POST', '/api/sync/delete-capture-batch', captureDeletePayload);
    assert.equal(deletedCapture.accepted, 1, '批量删除采集记录应持久化删除');
    const replayedCaptureDelete = await api(alice.token, 'POST', '/api/sync/delete-capture-batch', captureDeletePayload);
    assert.equal(replayedCaptureDelete.replayed, true);
    const afterCaptureDelete = await api(alice.token, 'GET', '/api/sync/snapshot');
    assert.equal(afterCaptureDelete.state.captures.some(item => item.id === 'capture-1'), false);
    assert.equal(afterCaptureDelete.state.customers.some(item => item.id === 'import-1'), true, '删除采集记录不得删除客户');

    const pendingOnlyCustomer = customer('pending-only-import', '仅待确认导入', '17000000016');
    const pendingOnlyPayload = { importId: 'pending-only-import-test', batchIndex: 0, totalBatches: 1, customers: [pendingOnlyCustomer], captures: [] };
    const pendingOnlyImport = await api(alice.token, 'POST', '/api/sync/import-batch', pendingOnlyPayload);
    assert.equal(pendingOnlyImport.accepted, 1, '不带采集记录的 Excel 导入应正常写入');
    const pendingOnlySnapshot = await api(alice.token, 'GET', '/api/sync/snapshot');
    assert.equal(pendingOnlySnapshot.state.customers.find(item => item.id === pendingOnlyCustomer.id)?.approval, '待确认');
    assert.equal(pendingOnlySnapshot.state.captures.some(item => item.customerId === pendingOnlyCustomer.id), false, 'Excel 导入不得生成抖音采集记录');

    const directImportCustomer = customer('direct-import-customer', '直接加入客户库', '17000000017');
    const directImport = await api(alice.token, 'POST', '/api/sync/jobs', {
      jobId: 'direct-import-test', operation: 'directImport', batches: [{
        batchIndex: 0,
        payload: {
          import: { importId: 'direct-import-test', batchIndex: 0, totalBatches: 1, customers: [directImportCustomer], captures: [capture('direct-import-capture', directImportCustomer.id)], captureMode: 'none' },
          promote: { importId: 'direct-import-promote-test', batchIndex: 0, totalBatches: 1, customerIds: [directImportCustomer.id] }
        }
      }]
    }, 202);
    let directImportStatus = directImport;
    for (let attempt = 0; attempt < 40 && !['completed', 'failed'].includes(directImportStatus.status); attempt += 1) {
      await sleep(100);
      directImportStatus = await api(alice.token, 'GET', '/api/sync/jobs/direct-import-test');
    }
    assert.equal(directImportStatus.status, 'completed', directImportStatus.lastError || '直接加入客户库任务未完成');
    const directImportSnapshot = await api(alice.token, 'GET', '/api/sync/snapshot');
    assert.equal(directImportSnapshot.state.customers.find(item => item.id === directImportCustomer.id)?.approval, '正式');
    assert.equal(directImportSnapshot.state.captures.some(item => item.customerId === directImportCustomer.id), false, '加入客户库不得生成客户采集记录');

    const atomicBatchOne = { importId: 'atomic-import-test', batchIndex: 0, totalBatches: 2,
      customers: [customer('atomic-1', '原子一', '17000000011')], captures: [capture('atomic-capture-1', 'atomic-1')] };
    const atomicBatchTwo = { importId: 'atomic-import-test', batchIndex: 1, totalBatches: 2,
      customers: [customer('atomic-2', '原子二', '17000000012')], captures: [capture('atomic-capture-2', 'atomic-2')] };
    await api(alice.token, 'POST', '/api/sync/import-batch', atomicBatchOne);
    const duringAtomicImport = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    assert.equal(duringAtomicImport.customers.some(item => item.id === 'atomic-1'), true, '成功写入的内部批次应立即对团队成员可见');
    await api(alice.token, 'POST', '/api/sync/import-batch', atomicBatchTwo);
    const afterAtomicSnapshot = await api(alice.token, 'GET', '/api/sync/snapshot');
    const afterAtomicImport = afterAtomicSnapshot.state;
    assert.equal(afterAtomicImport.customers.some(item => item.id === 'atomic-1'), true);
    assert.equal(afterAtomicImport.customers.some(item => item.id === 'atomic-2'), true);

    const duplicate = customer('pending-duplicate', '重复待确认', '17000000010');
    const unique = customer('pending-unique', '唯一待确认', '17000000003');
    const localOnly = customer('pending-local-only', '本地待确认', '17000000004');
    const contactNote = customer('pending-contact-note', '联系方式说明待确认', '17000000008');
    contactNote.douyin_id = '未确认公开联系方式';
    const contactSource = customer('pending-contact-source', '联系方式来源待确认', '17000000013');
    contactSource.douyin_id = '联系方式来源：公开搜索卡片或主页文本';
    const state = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    const officialContactNote = customer('official-contact-note', '联系方式说明正式客户', '17000000009', '正式');
    officialContactNote.douyin_id = '未确认公开联系方式';
    const officialContactSource = customer('official-contact-source', '联系方式来源正式客户', '17000000014', '正式');
    officialContactSource.douyin_id = '联系方式来源：公开搜索卡片或主页文本';
    const officialContactFields = customer('official-contact-fields', '联系方式字段正式客户', '17000000019', '正式');
    officialContactFields.wechat_id = 'official-wechat-id';
    officialContactFields.douyin_id = 'official-douyin-id';
    const officialOne = customer('official-1', '正式客户', '17000000010', '正式');
    officialOne.org_name = '原机构';
    officialOne.joinedAt = '2026-08-01T00:00:00.000Z';
    officialOne.statusHistory = [{ from: '', to: '新客户', at: '2026-08-01T00:00:00.000Z', user: 'alice' }];
    const multiMatchOne = customer('official-multi-1', '多重匹配一', '17000000021', '正式');
    const multiMatchTwo = customer('official-multi-2', '多重匹配二', '17000000022', '正式');
    const queuedReplaceCustomer = customer('official-queued-replace', '队列替换前', '17000000024', '正式');
    multiMatchOne.wechat_id = 'same-wechat';
    multiMatchTwo.wechat_id = 'same-wechat';
    state.customers.push(officialOne, officialContactNote, officialContactSource, officialContactFields, multiMatchOne, multiMatchTwo, queuedReplaceCustomer, duplicate, unique, contactNote, contactSource);
    state.tasks.push({ id: 'duplicate-task', customerId: duplicate.id, title: '重复客户关联任务' });
    state.feedback.push({ id: 'duplicate-feedback', customerId: duplicate.id, content: '重复客户关联反馈' });
    state.chats.push({ id: 'duplicate-chat', customerId: duplicate.id, messages: [] });
    state.captures.push(capture('duplicate-capture', duplicate.id));
    state.captures.push(capture('pending-unique-capture', unique.id));
    const seeded = await api(alice.token, 'PUT', '/api/sync/state', { state, baseVersion: afterAtomicSnapshot.version });
    const bob = await register('bob');
    const bobSnapshot = await api(bob.token, 'GET', '/api/sync/snapshot');
    const permissionPending = customer('permission-pending', '无权限待确认', '17000000015');
    permissionPending.userId = bob.user.id;
    permissionPending.created_by_user_id = bob.user.id;
    const permissionOfficial = customer('permission-official', '无权限正式客户', '17000000023', '正式');
    permissionOfficial.userId = bob.user.id;
    permissionOfficial.created_by_user_id = bob.user.id;
    bobSnapshot.state.customers.push(permissionPending, permissionOfficial);
    const bobSeed = await api(bob.token, 'PUT', '/api/sync/state', { state: bobSnapshot.state, baseVersion: bobSnapshot.version });

    const replacePayload = { importId: 'replace-duplicates-test', items: [
      { rowKey: 'safe-row', targetCustomerId: 'official-1', data: { phone: '17000000010', name: 'Excel 新姓名', qq: '00112233', org_name: '', managed_wechat_account: '业务微信A', sales_status: '已联系' } },
      { rowKey: 'same-target-a', targetCustomerId: 'official-contact-note', data: { phone: '17000000009', name: '同目标一' } },
      { rowKey: 'same-target-b', targetCustomerId: 'official-contact-note', data: { phone: '17000000009', name: '同目标二' } },
      { rowKey: 'multi-match', targetCustomerId: 'official-multi-1', data: { wechat_id: 'same-wechat', name: '多重匹配导入' } },
      { rowKey: 'permission-row', targetCustomerId: 'permission-official', data: { phone: '17000000023', name: '无权限替换' } }
    ] };
    const replaced = await apiWithRequestId(alice.token, 'POST', '/api/sync/replace-duplicate-batch', replacePayload, 'replace-duplicates-request');
    assert.equal(replaced.replaced, 1);
    assert.deepEqual(replaced.replacedRowKeys, ['safe-row']);
    assert.deepEqual(replaced.conflictRowKeys.sort(), ['multi-match', 'same-target-a', 'same-target-b']);
    assert.deepEqual(replaced.permissionRowKeys, ['permission-row']);
    const replayedReplacement = await apiWithRequestId(alice.token, 'POST', '/api/sync/replace-duplicate-batch', replacePayload, 'replace-duplicates-request');
    assert.equal(replayedReplacement.replayed, true, '同一请求重试必须幂等');
    const afterReplacement = await api(alice.token, 'GET', '/api/sync/snapshot');
    const replacedCustomer = afterReplacement.state.customers.find(item => item.id === 'official-1');
    assert.equal(replacedCustomer.name, 'Excel 新姓名');
    assert.equal(replacedCustomer.qq, '00112233', '批量导入替换应保存 QQ 号并保留前导零');
    assert.equal(replacedCustomer.org_name, '原机构', 'Excel 空白字段不得覆盖原值');
    assert.equal(replacedCustomer.managed_wechat_account, '业务微信A');
    assert.deepEqual(replacedCustomer.managed_wechat_accounts, ['业务微信A'], '旧单账户导入必须同步为兼容的账户数组');
    assert.equal(replacedCustomer.sales_status, '已联系');
    assert.equal(replacedCustomer.joinedAt, '2026-08-01T00:00:00.000Z', '正式入库时间必须保留');
    assert.equal(replacedCustomer.created_by_user_id, alice.user.id, '归属人必须保留');
    assert.ok(replacedCustomer.statusHistory.some(item => item.from === '新客户' && item.to === '已联系' && String(item.operatorUserId) === String(alice.user.id)), '销售状态替换必须记录操作人和状态历史');
    assert.equal(afterReplacement.state.customers.find(item => item.id === 'official-contact-note').name, '联系方式说明正式客户');
    assert.equal(afterReplacement.state.customers.find(item => item.id === 'permission-official').name, '无权限正式客户');
    const queuedReplace = await api(alice.token, 'POST', '/api/sync/jobs', {
      jobId: 'queued-replace-test', operation: 'replace', batches: [{
        batchIndex: 0,
        payload: {
          importId: 'queued-replace-test',
          items: [{
            rowKey: 'queued-safe-row', targetCustomerId: queuedReplaceCustomer.id,
            data: { phone: queuedReplaceCustomer.phone, name: '队列替换后', org_name: '后台持久化机构' }
          }]
        }
      }]
    }, 202);
    let queuedReplaceStatus = queuedReplace;
    for (let attempt = 0; attempt < 40 && !['completed', 'failed'].includes(queuedReplaceStatus.status); attempt += 1) {
      await sleep(100);
      queuedReplaceStatus = await api(alice.token, 'GET', '/api/sync/jobs/queued-replace-test');
    }
    assert.equal(queuedReplaceStatus.status, 'completed', queuedReplaceStatus.lastError || '后台批量替换任务未完成');
    assert.deepEqual(queuedReplaceStatus.replacedRowKeys, ['queued-safe-row']);
    assert.deepEqual(queuedReplaceStatus.conflictRowKeys, []);
    assert.deepEqual(queuedReplaceStatus.replacementPermissionRowKeys, []);
    const queuedReplaceSnapshot = await api(alice.token, 'GET', '/api/sync/snapshot');
    assert.equal(queuedReplaceSnapshot.state.customers.find(item => item.id === queuedReplaceCustomer.id).name, '队列替换后');
    assert.equal(queuedReplaceSnapshot.state.customers.find(item => item.id === queuedReplaceCustomer.id).org_name, '后台持久化机构');
    const queuedPending = [customer('queued-pending-1', '队列待确认一', '17000000005'), customer('queued-pending-2', '队列待确认二', '17000000006')];
    const queuedSnapshot = await api(alice.token, 'GET', '/api/sync/snapshot');
    queuedSnapshot.state.customers.push(...queuedPending);
    const queuedSeed = await api(alice.token, 'PUT', '/api/sync/state', { state: queuedSnapshot.state, baseVersion: queuedSnapshot.version });
    const queuedPromote = await api(alice.token, 'POST', '/api/sync/jobs', {
      jobId: 'queued-promote-test', operation: 'promote', batches: [{
        batchIndex: 0,
        payload: {
          importId: 'queued-promote-test', batchIndex: 0, totalBatches: 1,
          customerIds: queuedPending.map(item => item.id), customers: queuedPending
        }
      }]
    }, 202);
    let queuedPromoteStatus = queuedPromote;
    for (let attempt = 0; attempt < 40 && !['completed', 'failed'].includes(queuedPromoteStatus.status); attempt += 1) {
      await sleep(100);
      queuedPromoteStatus = await api(alice.token, 'GET', '/api/sync/jobs/queued-promote-test');
    }
    assert.equal(queuedPromoteStatus.status, 'completed', queuedPromoteStatus.lastError || '后台批量加入任务未完成');
    assert.equal(queuedPromoteStatus.accepted, 2);
    const queuedPromotedSnapshot = await api(alice.token, 'GET', '/api/sync/snapshot');
    const queuedPromotedState = queuedPromotedSnapshot.state;
    assert.equal(queuedPromotedState.customers.find(item => item.id === 'queued-pending-1').approval, '正式');
    assert.equal(queuedPromotedState.customers.find(item => item.id === 'queued-pending-2').approval, '正式');

    const safeSeedSnapshot = await api(alice.token, 'GET', '/api/sync/snapshot');
    const safeOfficialOne = customer('safe-official-1', '安全替换正式一', '13999900001', '正式');
    const safeOfficialTwo = customer('safe-official-2', '安全替换正式二', '13999900002', '正式');
    const safeExistingPending = customer('safe-existing-pending', '已有待确认', '13999900002');
    safeSeedSnapshot.state.customers.push(safeOfficialOne, safeOfficialTwo, safeExistingPending);
    const safeSeeded = await api(alice.token, 'PUT', '/api/sync/state', { state: safeSeedSnapshot.state, baseVersion: safeSeedSnapshot.version });
    const safeImportedOne = customer('safe-import-one', '新待确认一', '13999900001');
    const safeImportedTwo = customer('safe-import-two', '重复待确认', '13999900002');
    const safeImportResponse = await api(alice.token, 'POST', '/api/sync/safe-replacement-pending-batch', {
      importId: 'safe-replacement-pending-test', batchIndex: 0, totalBatches: 1,
      customers: [safeImportedOne, safeImportedTwo],
      captures: [capture('safe-capture-one', safeImportedOne.id), capture('safe-capture-two', safeImportedTwo.id)],
      targetCustomerIds: [safeOfficialOne.id, safeOfficialTwo.id]
    });
    assert.equal(safeImportResponse.accepted, 1);
    assert.equal(safeImportResponse.skipped, 1);
    assert.equal(safeImportResponse.duplicateSkipped, 1);
    const safeResultState = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    assert.equal(safeResultState.customers.filter(item => item.id === safeImportedOne.id).length, 1);
    assert.equal(safeResultState.customers.some(item => item.id === safeImportedTwo.id), false);
    assert.equal(safeResultState.customers.find(item => item.id === safeOfficialOne.id).name, safeOfficialOne.name);
    assert.equal(safeResultState.customers.find(item => item.id === safeOfficialTwo.id).name, safeOfficialTwo.name);
    assert.equal(safeResultState.captures.some(item => item.customerId === safeImportedOne.id || item.customerId === safeImportedTwo.id), false, '安全替换加入待确认客户不得生成客户采集记录');

    const capturePromoteState = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    const captureToPromote = { id: 'capture-promote-unique', name: '采集转正式', province: '四川', city: '成都', phone: '17000000030', qq: '0009988', created_by_user_id: alice.user.id, createdBy: 'alice', created_by_username: 'alice', createdAt: new Date().toISOString() };
    const captureDuplicate = { id: 'capture-promote-duplicate', name: '采集重复', province: '四川', city: '成都', phone: '17000000010', created_by_user_id: alice.user.id, createdBy: 'alice', created_by_username: 'alice', createdAt: new Date().toISOString() };
    capturePromoteState.captures.push(captureToPromote, captureDuplicate);
    await api(alice.token, 'PUT', '/api/sync/state', { state: capturePromoteState, baseVersion: (await api(alice.token, 'GET', '/api/sync/snapshot')).version });
    const queuedCapturePromote = await api(alice.token, 'POST', '/api/sync/jobs', {
      jobId: 'queued-capture-promote-test', operation: 'capturePromote', batches: [{
        batchIndex: 0,
        payload: { importId: 'queued-capture-promote-test', batchIndex: 0, totalBatches: 1, captureIds: [captureToPromote.id, captureDuplicate.id], captures: [captureToPromote, captureDuplicate] }
      }]
    }, 202);
    let queuedCapturePromoteStatus = queuedCapturePromote;
    for (let attempt = 0; attempt < 40 && !['completed', 'failed'].includes(queuedCapturePromoteStatus.status); attempt += 1) {
      await sleep(100);
      queuedCapturePromoteStatus = await api(alice.token, 'GET', '/api/sync/jobs/queued-capture-promote-test');
    }
    assert.equal(queuedCapturePromoteStatus.status, 'completed', queuedCapturePromoteStatus.lastError || '后台采集加入客户库任务未完成');
    assert.equal(queuedCapturePromoteStatus.accepted, 1);
    assert.equal(queuedCapturePromoteStatus.duplicateSkipped, 1);
    assert.deepEqual(queuedCapturePromoteStatus.duplicateSkippedIds, [captureDuplicate.id]);
    assert.deepEqual(queuedCapturePromoteStatus.duplicateTargetIds[captureDuplicate.id], ['official-1']);
    const afterCapturePromote = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    assert.equal(afterCapturePromote.customers.some(item => item.name === captureToPromote.name && item.approval === '正式'), true);
    assert.equal(afterCapturePromote.customers.find(item => item.name === captureToPromote.name)?.qq || '', captureToPromote.qq || '', '采集转客户应保留 QQ 号');
    assert.equal(afterCapturePromote.captures.some(item => item.id === captureToPromote.id), false, '成功转入客户库的采集记录应移除');
    assert.equal(afterCapturePromote.captures.some(item => item.id === captureDuplicate.id), true, '重复采集记录应保留');
    const replayedCapturePromote = await api(alice.token, 'POST', '/api/sync/promote-capture-batch', {
      importId: 'queued-capture-promote-test', batchIndex: 0, totalBatches: 1,
      captureIds: [captureToPromote.id, captureDuplicate.id], captures: [captureToPromote, captureDuplicate]
    });
    assert.equal(replayedCapturePromote.replayed, true, '采集转正式重试必须幂等');
    assert.equal(replayedCapturePromote.accepted, 1);

    const captureMatchRuleState = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    const captureSameNameDifferentContacts = { id: 'capture-same-name-different-contacts', name: '正式客户', province: '四川', city: '成都', phone: '17000000101', wechat_id: 'new-wechat-id', douyin_id: 'new-douyin-id', created_by_user_id: alice.user.id, createdBy: 'alice', created_by_username: 'alice', createdAt: new Date().toISOString() };
    const captureWithoutContacts = { id: 'capture-without-contacts', name: '没有联系方式', province: '四川', city: '成都', phone: '', wechat_id: '', douyin_id: '', created_by_user_id: alice.user.id, createdBy: 'alice', created_by_username: 'alice', createdAt: new Date().toISOString() };
    const capturePhoneMatch = { id: 'capture-phone-match', name: '手机号重复但姓名不同', phone: officialContactFields.phone, created_by_user_id: alice.user.id, createdBy: 'alice', created_by_username: 'alice', createdAt: new Date().toISOString() };
    const captureWechatMatch = { id: 'capture-wechat-match', name: '微信号重复但姓名不同', wechat_id: officialContactFields.wechat_id, created_by_user_id: alice.user.id, createdBy: 'alice', created_by_username: 'alice', createdAt: new Date().toISOString() };
    const captureDouyinMatch = { id: 'capture-douyin-match', name: '抖音号重复但姓名不同', douyin_id: officialContactFields.douyin_id, created_by_user_id: alice.user.id, createdBy: 'alice', created_by_username: 'alice', createdAt: new Date().toISOString() };
    const captureMatchRuleRows = [captureSameNameDifferentContacts, captureWithoutContacts, capturePhoneMatch, captureWechatMatch, captureDouyinMatch];
    captureMatchRuleState.captures.push(...captureMatchRuleRows);
    const captureMatchRuleSeed = await api(alice.token, 'PUT', '/api/sync/state', { state: captureMatchRuleState, baseVersion: (await api(alice.token, 'GET', '/api/sync/snapshot')).version });
    const captureMatchRuleResult = await api(alice.token, 'POST', '/api/sync/promote-capture-batch', {
      importId: 'capture-match-rule-test', batchIndex: 0, totalBatches: 1,
      captureIds: captureMatchRuleRows.map(item => item.id), captures: captureMatchRuleRows
    });
    assert.equal(captureMatchRuleResult.accepted, 2, '姓名相同但联系方式不同、以及无联系方式的采集客户应允许加入客户库');
    assert.equal(captureMatchRuleResult.duplicateSkipped, 3, '手机号、微信号、抖音号分别重复时应阻止加入客户库');
    assert.deepEqual(captureMatchRuleResult.duplicateSkippedIds, [capturePhoneMatch.id, captureWechatMatch.id, captureDouyinMatch.id]);
    const captureMatchRuleAfter = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    assert.equal(captureMatchRuleAfter.captures.some(item => item.id === captureSameNameDifferentContacts.id), false);
    assert.equal(captureMatchRuleAfter.captures.some(item => item.id === captureWithoutContacts.id), false);
    assert.equal(captureMatchRuleAfter.captures.some(item => item.id === capturePhoneMatch.id), true);
    assert.equal(captureMatchRuleAfter.captures.some(item => item.id === captureWechatMatch.id), true);
    assert.equal(captureMatchRuleAfter.captures.some(item => item.id === captureDouyinMatch.id), true);

    const multiBatchPending = Array.from({ length: 501 }, (_, index) => customer(`multi-pending-${index + 1}`, `多批次待确认${index + 1}`, `139${String(index + 1).padStart(8, '0')}`));
    const multiBatchState = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    multiBatchState.customers.push(...multiBatchPending);
    await api(alice.token, 'PUT', '/api/sync/state', { state: multiBatchState, baseVersion: (await api(alice.token, 'GET', '/api/sync/snapshot')).version });
    const multiBatchPayloads = [];
    for (let batchIndex = 0; batchIndex < multiBatchPending.length; batchIndex += 200) {
      const rows = multiBatchPending.slice(batchIndex, batchIndex + 200);
      multiBatchPayloads.push({ batchIndex: multiBatchPayloads.length, payload: {
        importId: 'multi-batch-promote-test', batchIndex: multiBatchPayloads.length, totalBatches: 3,
        customerIds: rows.map(item => item.id)
      } });
    }
    const multiBatchJob = await api(alice.token, 'POST', '/api/sync/jobs', {
      jobId: 'multi-batch-promote-test', operation: 'promote', batches: multiBatchPayloads
    }, 202);
    let multiBatchStatus = multiBatchJob;
    for (let attempt = 0; attempt < 80 && !['completed', 'failed'].includes(multiBatchStatus.status); attempt += 1) {
      await sleep(100);
      multiBatchStatus = await api(alice.token, 'GET', '/api/sync/jobs/multi-batch-promote-test');
    }
    assert.equal(multiBatchStatus.status, 'completed', multiBatchStatus.lastError || '多批次后台加入任务未完成');
    assert.equal(multiBatchStatus.completedBatches, 3);
    assert.equal(multiBatchStatus.accepted, multiBatchPending.length);
    const multiBatchPromotedState = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    assert.equal(multiBatchPromotedState.customers.filter(item => item.id.startsWith('multi-pending-') && item.approval === '正式').length, multiBatchPending.length);
    const pendingDeleteOnly = customer('pending-delete-only', '待确认删除', '17000000007');
    const pendingDeleteState = await api(alice.token, 'GET', '/api/sync/snapshot');
    pendingDeleteState.state.customers.push(pendingDeleteOnly);
    await api(alice.token, 'PUT', '/api/sync/state', { state: pendingDeleteState.state, baseVersion: pendingDeleteState.version });
    const pendingDeletePayload = { importId: 'pending-delete-test', batchIndex: 0, totalBatches: 1, customerIds: [pendingDeleteOnly.id], includePending: true };
    const pendingDeleted = await api(alice.token, 'POST', '/api/sync/delete-customer-batch', pendingDeletePayload);
    assert.equal(pendingDeleted.accepted, 1, 'includePending 批量删除应删除待确认客户');
    const pendingDeleteAfter = await api(alice.token, 'GET', '/api/sync/snapshot');
    assert.equal(pendingDeleteAfter.state.customers.some(item => item.id === pendingDeleteOnly.id), false);
    const pendingOnlyOfficial = await api(alice.token, 'POST', '/api/sync/delete-customer-batch', {
      importId: 'pending-only-official-test', batchIndex: 0, totalBatches: 1,
      customerIds: ['official-1'], includePending: true, pendingOnly: true
    });
    assert.equal(pendingOnlyOfficial.accepted, 0, 'pendingOnly 删除不得移除已转为正式的客户');
    assert.deepEqual(pendingOnlyOfficial.statusChangedIds, ['official-1']);
    const pendingOnlyOfficialAfter = await api(alice.token, 'GET', '/api/sync/snapshot');
    assert.equal(pendingOnlyOfficialAfter.state.customers.some(item => item.id === 'official-1'), true);
    const promotePayload = { importId: 'promote-test', batchIndex: 0, totalBatches: 1,
      customerIds: ['pending-duplicate', 'pending-unique', 'pending-local-only', 'pending-contact-note', 'pending-contact-source', 'permission-pending'], customers: [localOnly] };
    const promoted = await api(alice.token, 'POST', '/api/sync/promote-batch', promotePayload);
    assert.equal(promoted.accepted, 4);
    assert.equal(promoted.skipped, 2);
    assert.deepEqual(promoted.duplicateSkippedIds, ['pending-duplicate']);
    assert.deepEqual(promoted.permissionSkippedIds, ['permission-pending']);
    const promotedState = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    assert.equal(promotedState.customers.find(item => item.id === 'pending-unique').approval, '正式');
    assert.equal(promotedState.customers.find(item => item.id === 'pending-local-only').approval, '正式');
    assert.equal(promotedState.customers.find(item => item.id === 'pending-contact-note').approval, '正式', '联系方式说明不得当作抖音号参与去重');
    assert.equal(promotedState.customers.find(item => item.id === 'pending-contact-source').approval, '正式', '联系方式来源说明不得当作抖音号参与去重');
    assert.equal(promotedState.customers.find(item => item.id === 'pending-duplicate').approval, '待确认', '重复客户应继续保留在待确认列表');
    assert.equal(promotedState.customers.find(item => item.id === 'permission-pending').approval, '待确认', '无权限客户应继续保留在待确认列表');
    assert.equal(promotedState.customers.some(item => item.id === 'official-1'), true, '合并时必须保留正式客户');
    assert.equal(promotedState.tasks.find(item => item.id === 'duplicate-task').customerId, 'pending-duplicate');
    assert.equal(promotedState.feedback.find(item => item.id === 'duplicate-feedback').customerId, 'pending-duplicate');
    assert.equal(promotedState.chats.find(item => item.id === 'duplicate-chat').customerId, 'pending-duplicate');
    assert.equal(promotedState.captures.find(item => item.id === 'duplicate-capture').customerId, 'pending-duplicate');
    assert.equal(promotedState.captures.find(item => item.id === 'duplicate-capture').confirmed, undefined);
    assert.equal(promotedState.captures.some(item => item.id === 'pending-unique-capture'), false, '成功加入客户库应移除关联采集记录');
    const replayedPromote = await api(alice.token, 'POST', '/api/sync/promote-batch', promotePayload);
    assert.equal(replayedPromote.replayed, true);
    assert.equal(replayedPromote.accepted, 4);
    assert.equal(replayedPromote.skipped, 2);
    assert.deepEqual(replayedPromote.duplicateSkippedIds, ['pending-duplicate']);
    assert.deepEqual(replayedPromote.permissionSkippedIds, ['permission-pending']);
    const missingQueueCompletion = await api(alice.token, 'POST', '/api/sync/queue/complete', { queueId: 'already-cleaned-queue' });
    assert.equal(missingQueueCompletion.status, 'completed');
    assert.equal(missingQueueCompletion.missing, true);
    const deletionState = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    deletionState.tasks.push({ id: 'delete-task', customerId: 'pending-unique', title: '关联任务' });
    deletionState.feedback.push({ id: 'delete-feedback', customerId: 'pending-unique', content: '关联反馈' });
    deletionState.chats.push({ id: 'delete-chat', customerId: 'pending-unique', messages: [] });
    deletionState.captures.push(capture('delete-capture', 'pending-unique'));
    const seededDeletionRelations = await api(alice.token, 'PUT', '/api/sync/state', { state: deletionState, baseVersion: replayedPromote.version });
    const deletePayload = { importId: 'delete-test', batchIndex: 0, totalBatches: 1, customerIds: ['pending-unique'] };
    const deleted = await api(alice.token, 'POST', '/api/sync/delete-customer-batch', deletePayload);
    assert.equal(deleted.accepted, 1);
    const replayedDelete = await api(alice.token, 'POST', '/api/sync/delete-customer-batch', deletePayload);
    assert.equal(replayedDelete.replayed, true);
    assert.equal(replayedDelete.accepted, 1);
    const afterDelete = (await api(alice.token, 'GET', '/api/sync/snapshot')).state;
    assert.equal(afterDelete.customers.some(item => item.id === 'pending-unique'), false);
    assert.equal(afterDelete.tasks.some(item => item.customerId === 'pending-unique'), false);
    assert.equal(afterDelete.feedback.some(item => item.customerId === 'pending-unique'), false);
    assert.equal(afterDelete.chats.some(item => item.customerId === 'pending-unique'), false);
    assert.equal(afterDelete.captures.some(item => item.customerId === 'pending-unique'), false);
    assert.equal(afterDelete.customers.some(item => item.id === 'official-1'), true);

    const alreadyProcessed = await api(alice.token, 'POST', '/api/sync/promote-batch', {
      importId: 'promote-already-processed-test', batchIndex: 0, totalBatches: 1,
      customerIds: ['official-1', 'missing-customer']
    });
    assert.equal(alreadyProcessed.accepted, 0);
    assert.equal(alreadyProcessed.skipped, 2);
    assert.deepEqual(alreadyProcessed.skippedIds.sort(), ['missing-customer', 'official-1']);
    assert.deepEqual(alreadyProcessed.duplicateSkippedIds.sort(), ['missing-customer', 'official-1']);
    const replayedAlreadyProcessed = await api(alice.token, 'POST', '/api/sync/promote-batch', {
      importId: 'promote-already-processed-test', batchIndex: 0, totalBatches: 1,
      customerIds: ['official-1', 'missing-customer']
    });
    assert.equal(replayedAlreadyProcessed.replayed, true);
    assert.equal(replayedAlreadyProcessed.accepted, 0);
    assert.equal(replayedAlreadyProcessed.skipped, 2);
    assert.deepEqual(replayedAlreadyProcessed.duplicateSkippedIds.sort(), ['missing-customer', 'official-1']);
    const emptyPromote = await api(alice.token, 'POST', '/api/sync/promote-batch', {
      importId: 'promote-empty-test', batchIndex: 0, totalBatches: 1, customerIds: []
    });
    assert.equal(emptyPromote.accepted, 0);
    assert.equal(emptyPromote.skipped, 0);
    const replayedEmptyPromote = await api(alice.token, 'POST', '/api/sync/promote-batch', {
      importId: 'promote-empty-test', batchIndex: 0, totalBatches: 1, customerIds: []
    });
    assert.equal(replayedEmptyPromote.replayed, true);
    assert.equal(replayedEmptyPromote.accepted, 0);
    assert.equal(replayedEmptyPromote.skipped, 0);
    const db = new Database(dbPath);
    const raw = JSON.parse(db.prepare('SELECT state_json FROM workspace_states LIMIT 1').get().state_json);
    assert.equal(raw.customers.filter(item => item.id === 'import-1').length, 1);
    assert.equal(raw.customers.filter(item => item.id === 'import-2').length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM workspace_import_batches').get().count, 20);
    db.close();
    console.log('Import batch integration tests passed');
  } catch (error) {
    console.error(error.stack || error);
    console.error(logs);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
  }
})();
