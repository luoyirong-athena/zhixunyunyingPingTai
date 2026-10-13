#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const serverDir = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixun-dashboard-history-'));
const port = 3500 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
let logs = '';
const child = spawn(process.execPath, ['src/index.js'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(port), JWT_SECRET: 'dashboard-history-test-secret', ADMIN_DEFAULT_PASSWORD: 'demo123', ZHIXUN_DB_PATH: path.join(tempDir, 'test.db'), ZHIXUN_MATERIALS_DIR: path.join(tempDir, 'materials'), NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch (_) {}
    await sleep(100);
  }
  throw new Error(`测试服务启动超时\n${logs}`);
}
async function api(token, method, endpoint, body, extraHeaders = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders };
  const options = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${endpoint}`, options);
  const data = await response.json();
  assert.ok(response.ok, `${method} ${endpoint}: ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  try {
    await waitForServer();
    const alice = await api(null, 'POST', '/api/auth/register', { username: 'history-user', password: 'portfolio-test-pass-123', confirm_password: 'portfolio-test-pass-123', display_name: '历史测试用户' });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const customers = Array.from({ length: 10 }, (_, index) => ({
      id: `history-customer-${index + 1}`,
      name: `历史客户${index + 1}`,
      province: '江苏',
      sales_status: '新客户',
      approval: '正式',
      createdAt: index === 0 ? yesterday : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      statusHistory: []
    }));
    const initial = { version: 2, customers, tasks: [], feedback: [], chats: [], captures: [], scripts: [], experiences: [], materials: [], logs: [], statuses: [], settings: {} };
    const bootstrap = await api(alice.token, 'POST', '/api/sync/bootstrap', { state: initial });
    const changed = JSON.parse(JSON.stringify(bootstrap.state));
    changed.customers.forEach((customer, index) => { customer.sales_status = index % 2 ? '高意向' : '已加微信'; customer.updatedAt = new Date().toISOString(); });
    const saved = await api(alice.token, 'PUT', '/api/sync/state', { state: changed, baseVersion: bootstrap.version });
    const today = await api(alice.token, 'GET', '/api/sync/status-history/today');
    assert.equal(today.total, 10);
    assert.equal(today.records.length, 10);
    const secondChange = JSON.parse(JSON.stringify(saved.state));
    secondChange.customers[0].sales_status = '已付费';
    await api(alice.token, 'PUT', '/api/sync/state', { state: secondChange, baseVersion: saved.version });
    const afterSecondChange = await api(alice.token, 'GET', '/api/sync/status-history/today');
    assert.equal(afterSecondChange.total, 10, '同一客户当天多次变更仍只计一位');
    assert.equal(afterSecondChange.records.length, 10);
    assert.equal(afterSecondChange.records.find(row => row.customer_id === 'history-customer-1').to_status, '已付费');
    const historicalRange = await api(alice.token, 'GET', `/api/sync/status-history/range?from=${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 1000).toISOString())}`);
    assert.equal(historicalRange.records.filter(row => row.customer_id === 'history-customer-1').length, 2, '历史接口必须保留同一客户的每一次状态变化');
    assert.ok(historicalRange.records.length >= 11, '历史接口应返回逐条状态变化记录');

    // Exercise the background patch path used by the browser, including an
    // existing customer added before today and a later non-status edit.
    const patchBase = await api(alice.token, 'GET', '/api/sync/snapshot');
    const patchCustomer = patchBase.state.customers[1];
    const patchRequestId = 'dashboard-history-patch-1';
    const patch = {
      replace: {},
      arrays: {
        customers: {
          update: [{
            id: patchCustomer.id,
            expectedVersion: Number(patchCustomer.syncVersion || 0),
            fields: { sales_status: '已联系', updatedAt: new Date().toISOString() }
          }]
        }
      }
    };
    const patched = await api(alice.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'dashboard-history-patch-operation',
      batchIndex: 0,
      totalBatches: 1,
      baseVersion: patchBase.version,
      patch,
      requestId: patchRequestId
    }, { 'X-Request-Id': patchRequestId });
    const afterPatch = await api(alice.token, 'GET', '/api/sync/snapshot');
    assert.equal(afterPatch.state.customers.find(row => row.id === patchCustomer.id).sales_status, '已联系');

    const editRequestId = 'dashboard-history-detail-edit-1';
    const edited = await api(alice.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'dashboard-history-detail-edit-operation',
      batchIndex: 0,
      totalBatches: 1,
      baseVersion: patched.version,
      patch: {
        replace: {},
        arrays: { customers: { update: [{ id: patchCustomer.id, fields: { name: '历史客户编辑后', updatedAt: new Date().toISOString() } }] } }
      },
      requestId: editRequestId
    }, { 'X-Request-Id': editRequestId });
    const afterDetailEdit = await api(alice.token, 'GET', '/api/sync/snapshot');
    const editedCustomer = afterDetailEdit.state.customers.find(row => row.id === patchCustomer.id);
    assert.equal(editedCustomer.name, '历史客户编辑后');
    assert.equal(editedCustomer.sales_status, '已联系');
    assert.ok(editedCustomer.statusHistory.some(row => row.to === '已联系'), '编辑客户资料不得覆盖已有状态历史');
    const afterPatchHistory = await api(alice.token, 'GET', '/api/sync/status-history/today');
    assert.equal(afterPatchHistory.records.find(row => row.customer_id === patchCustomer.id).to_status, '已联系');

    // A delayed batch carrying an older field timestamp must not roll back a
    // newer customer edit, while a newer edit to another field still applies.
    const newerNameTime = '2030-01-01T00:00:00.000Z';
    const newerNameRequestId = 'dashboard-history-newer-name-1';
    const newerName = await api(alice.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'dashboard-history-newer-name-operation', batchIndex: 0, totalBatches: 1,
      baseVersion: afterDetailEdit.version,
      patch: { replace: {}, arrays: { customers: { update: [{ id: patchCustomer.id, fields: {
        name: '较新客户名称', updatedAt: newerNameTime, fieldUpdatedAt: { name: newerNameTime }
      } }] } } },
      requestId: newerNameRequestId
    }, { 'X-Request-Id': newerNameRequestId });
    const staleNameRequestId = 'dashboard-history-stale-name-1';
    await api(alice.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'dashboard-history-stale-name-operation', batchIndex: 0, totalBatches: 1,
      baseVersion: newerName.version,
      patch: { replace: {}, arrays: { customers: { update: [{ id: patchCustomer.id, fields: {
        name: '旧快照名称', updatedAt: '2029-01-01T00:00:00.000Z', fieldUpdatedAt: { name: '2029-01-01T00:00:00.000Z' }
      } }] } } },
      requestId: staleNameRequestId
    }, { 'X-Request-Id': staleNameRequestId });
    const newerPhoneRequestId = 'dashboard-history-newer-phone-1';
    await api(alice.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'dashboard-history-newer-phone-operation', batchIndex: 0, totalBatches: 1,
      baseVersion: newerName.version,
      patch: { replace: {}, arrays: { customers: { update: [{ id: patchCustomer.id, fields: {
        phone: '13900000000', updatedAt: '2031-01-01T00:00:00.000Z', fieldUpdatedAt: { phone: '2031-01-01T00:00:00.000Z' }
      } }] } } },
      requestId: newerPhoneRequestId
    }, { 'X-Request-Id': newerPhoneRequestId });
    const afterTimestampedMerges = await api(alice.token, 'GET', '/api/sync/snapshot');
    const timestampedCustomer = afterTimestampedMerges.state.customers.find(row => row.id === patchCustomer.id);
    assert.equal(timestampedCustomer.name, '较新客户名称', '旧批量快照不得覆盖较新的客户名称');
    assert.equal(timestampedCustomer.phone, '13900000000', '较新的其他字段应正常合并');
    console.log(JSON.stringify({ result: 'ok', total: afterSecondChange.total, records: afterSecondChange.records.length }, null, 2));
  } catch (error) {
    console.error(error.stack || error);
    console.error(`\n--- server output ---\n${logs}`);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(150);
    if (child.exitCode === null) child.kill('SIGKILL');
    if (!process.exitCode) fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
