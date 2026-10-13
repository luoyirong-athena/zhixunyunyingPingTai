#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const serverDir = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixun-sync-queue-'));
const dbPath = path.join(tempDir, 'test.db');
const port = 4100 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
let logs = '';
let db;
const child = spawn(process.execPath, ['src/index.js'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(port), JWT_SECRET: 'sync-queue-test-secret', ADMIN_DEFAULT_PASSWORD: 'demo123', ZHIXUN_DB_PATH: dbPath, NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer() {
  for (let index = 0; index < 900; index += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch (_) {}
    if (child.exitCode !== null) throw new Error(`测试服务提前退出\n${logs}`);
    await sleep(100);
  }
  throw new Error(`测试服务启动超时\n${logs}`);
}
async function api(token, method, endpoint, body, expectedStatus) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; if (body.requestId) headers['X-Request-Id'] = body.requestId; payload = JSON.stringify(body); }
  const response = await fetch(`${base}${endpoint}`, { method, headers, body: payload });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  if (expectedStatus === undefined) assert.ok(response.ok, `${method} ${endpoint}: ${response.status} ${text}`);
  else assert.equal(response.status, expectedStatus, `${method} ${endpoint}: ${text}`);
  return data;
}
async function waitFor(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(200);
  }
  throw new Error('等待服务端后台队列完成超时');
}

(async () => {
  try {
    await waitForServer();
    const registered = await api('', 'POST', '/api/auth/register', { username: 'queue-user', password: 'portfolio-test-pass-123', confirm_password: 'portfolio-test-pass-123', display_name: '队列测试' });
    const initial = {
      version: 2,
      customers: [{ id: 'customer-a', name: '客户A', phone: '13900000001', sales_status: '新客户', remark: '原备注', approval: '正式' }],
      tasks: [], feedback: [], chats: [], captures: [], scripts: [], experiences: [], materials: [], logs: [],
      statuses: [{ id: 'status-new', name: '新客户', color: '#315efb' }], settings: { identities: [] }
    };
    const bootstrap = await api(registered.token, 'POST', '/api/sync/bootstrap', { state: initial });
    const patch = { arrays: { customers: { update: [{ id: 'customer-a', fields: { sales_status: '已加微信', remark: '已更新' } }] } } };
    const payload = { operationId: 'queue-test', batchIndex: 0, totalBatches: 1, baseVersion: bootstrap.version, patch, requestId: 'queue-test-0' };
    const updated = await api(registered.token, 'POST', '/api/sync/backup-merge-batch', payload);
    assert.equal(updated.accepted, true);
    const replayed = await api(registered.token, 'POST', '/api/sync/backup-merge-batch', payload);
    assert.equal(replayed.version, updated.version);
    const state = (await api(registered.token, 'GET', '/api/sync/snapshot')).state;
    assert.equal(state.customers[0].sales_status, '已加微信');
    assert.equal(state.customers[0].remark, '已更新');

    db = new Database(dbPath);
    const teamId = db.prepare("SELECT id FROM teams WHERE code = 'operations-default'").get().id;
    const eventCursor = db.prepare('SELECT COALESCE(MAX(id), 0) cursor FROM sync_events WHERE team_id = ?').get(teamId).cursor;
    const insertEvent = db.prepare(`INSERT INTO sync_events
      (event_id, team_id, entity_type, entity_id, action, entity_version, payload)
      VALUES (?, ?, 'workspace', ?, 'workspace.updated', 0, '{}')`);
    db.transaction(() => {
      for (let index = 0; index < 501; index += 1) insertEvent.run(`pagination-${index}`, teamId, String(teamId));
    })();
    const firstEventPage = await api(registered.token, 'GET', `/api/sync/changes?cursor=${eventCursor}`);
    assert.equal(firstEventPage.events.length, 500, '事件接口应按上限返回第一页');
    assert.equal(firstEventPage.hasMore, true, '事件超过上限时应明确返回 hasMore');
    const secondEventPage = await api(registered.token, 'GET', `/api/sync/changes?cursor=${firstEventPage.cursor}`);
    assert.equal(secondEventPage.events.length, 1, '第二页应返回剩余事件');
    assert.equal(secondEventPage.hasMore, false, '事件已消费完后 hasMore 应为 false');

    const concurrentBaseVersion = updated.version;
    await api(registered.token, 'POST', '/api/sync/backup-merge-batch', {
      operationId: 'concurrent-direct', batchIndex: 0, totalBatches: 1,
      baseVersion: concurrentBaseVersion,
      patch: { arrays: { customers: { update: [{ id: 'customer-a', fields: { remark: '并发先提交' } }] } } },
      requestId: 'concurrent-direct-0'
    });
    const concurrentPatch = { arrays: { customers: { update: [{ id: 'customer-a', fields: { sales_status: '并发后提交' } }] } } };
    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-concurrent-rebase', operation: 'patch', batchIndex: 0, totalBatches: 1,
      payload: { operationId: 'worker-concurrent-rebase', batchIndex: 0, totalBatches: 1, baseVersion: concurrentBaseVersion, patch: concurrentPatch, requestId: 'worker-concurrent-rebase-0' }
    }, 202);
    await waitFor(async () => {
      const current = await api(registered.token, 'GET', '/api/sync/snapshot');
      const customer = current.state?.customers?.find(item => item.id === 'customer-a');
      return customer?.remark === '并发先提交' && customer?.sales_status === '并发后提交';
    });

    const workerPatch = { arrays: { customers: { update: [{ id: 'customer-a', fields: { remark: '服务端后台队列已完成' } }] } } };
    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-queue-test', operation: 'patch', batchIndex: 0, totalBatches: 1,
      payload: { operationId: 'worker-queue-operation', batchIndex: 0, totalBatches: 1, baseVersion: updated.version, patch: workerPatch, requestId: 'worker-queue-operation-0' }
    }, 202);
    await waitFor(async () => {
      const current = await api(registered.token, 'GET', '/api/sync/snapshot');
      return current.state?.customers?.[0]?.remark === '服务端后台队列已完成';
    });

    const beforeStaleStatus = await api(registered.token, 'GET', '/api/sync/snapshot');
    const staleStatusUpdatedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const currentStatus = beforeStaleStatus.state.customers[0].sales_status;
    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-stale-status', operation: 'patch', batchIndex: 0, totalBatches: 1,
      payload: {
        operationId: 'worker-stale-status-operation', batchIndex: 0, totalBatches: 1,
        baseVersion: beforeStaleStatus.version,
        patch: { arrays: { customers: { update: [{ id: 'customer-a', fields: { sales_status: currentStatus, updatedAt: staleStatusUpdatedAt } }] } } },
        requestId: 'worker-stale-status-operation-0'
      }
    }, 202);
    await api(registered.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'new-status-direct', batchIndex: 0, totalBatches: 1,
      baseVersion: beforeStaleStatus.version,
      patch: { arrays: { customers: { update: [{ id: 'customer-a', fields: { sales_status: '已加微信', updatedAt: new Date().toISOString() } }] } } },
      requestId: 'new-status-direct-0'
    });
    await new Promise(resolve => setTimeout(resolve, 3500));
    const afterStaleStatus = await api(registered.token, 'GET', '/api/sync/snapshot');
    assert.equal(afterStaleStatus.state.customers[0].sales_status, '已加微信', '旧后台补丁不得覆盖后来销售状态');

    const workerCustomer = { id: 'worker-customer', name: '后台客户', province: '江苏', sales_status: '新客户', approval: '待确认', source: '批量导入', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const workerCapture = { id: 'worker-capture', customerId: workerCustomer.id, name: workerCustomer.name, source: '批量导入', confirmed: false, createdAt: workerCustomer.createdAt };
    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-import-test', operation: 'import', batchIndex: 0, totalBatches: 1,
      payload: { importId: 'worker-import', batchIndex: 0, totalBatches: 1, customers: [workerCustomer], captures: [workerCapture] }
    }, 202);
    await waitFor(async () => (await api(registered.token, 'GET', '/api/sync/snapshot')).state?.customers?.some(item => item.id === workerCustomer.id));
    const mismatchCustomers = [
      { id: 'worker-mismatch-1', name: '队列待确认一', province: '江苏', sales_status: '新客户', approval: '待确认', source: '批量导入', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'worker-mismatch-2', name: '队列待确认二', province: '浙江', sales_status: '新客户', approval: '待确认', source: '批量导入', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    ];
    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-import-mismatch-test', operation: 'import', batchIndex: 0, totalBatches: 1,
      payload: {
        importId: 'worker-import-mismatch', batchIndex: 0, totalBatches: 1,
        customers: mismatchCustomers,
        captures: [{ id: 'stale-capture-row', customerId: mismatchCustomers[0].id }]
      }
    }, 202);
    const mismatchStatus = await waitFor(async () => {
      const status = await api(registered.token, 'GET', '/api/sync/jobs/worker-import-mismatch-test');
      return status.status === 'completed' ? status : status.status === 'failed' ? status : null;
    });
    assert.equal(mismatchStatus.status, 'completed', mismatchStatus.lastError || '客户与采集记录数量不一致时，待确认客户导入不应失败');
    assert.equal(mismatchStatus.accepted, 2);
    const mismatchSnapshot = await api(registered.token, 'GET', '/api/sync/snapshot');
    assert.equal(mismatchSnapshot.state.customers.filter(item => item.id.startsWith('worker-mismatch-')).length, 2);
    assert.equal(mismatchSnapshot.state.captures.some(item => item.customerId === mismatchCustomers[0].id || item.customerId === mismatchCustomers[1].id), false, '待确认客户导入不得生成客户采集记录');
    const captureSeedSnapshot = await api(registered.token, 'GET', '/api/sync/snapshot');
    captureSeedSnapshot.state.captures.push(workerCapture);
    await api(registered.token, 'PUT', '/api/sync/state', { state: captureSeedSnapshot.state, baseVersion: captureSeedSnapshot.version });
    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-capture-delete-test', operation: 'captureDelete', batchIndex: 0, totalBatches: 1,
      payload: { importId: 'worker-capture-delete', batchIndex: 0, totalBatches: 1, captureIds: [workerCapture.id] }
    }, 202);
    await waitFor(async () => !(await api(registered.token, 'GET', '/api/sync/snapshot')).state?.captures?.some(item => item.id === workerCapture.id));
    const captureDeleteStatus = await api(registered.token, 'GET', '/api/sync/jobs/worker-capture-delete-test');
    assert.equal(captureDeleteStatus.accepted, 1, '首次采集删除应成功');
    await api(registered.token, 'POST', '/api/sync/jobs', {
      jobId: 'worker-capture-delete-repeat', operation: 'captureDelete', priority: 40,
      batches: [{ batchIndex: 0, payload: { importId: 'worker-capture-delete-repeat', batchIndex: 0, totalBatches: 1, captureIds: [workerCapture.id] } }]
    }, 202);
    const repeatedCaptureDelete = await waitFor(async () => {
      const status = await api(registered.token, 'GET', '/api/sync/jobs/worker-capture-delete-repeat');
      return status.status === 'completed' ? status : null;
    });
    assert.deepEqual(repeatedCaptureDelete.alreadyAbsentIds, [workerCapture.id], '重复删除采集记录应明确归类为已不存在');

    const jobCursor = (await api(registered.token, 'GET', '/api/sync/snapshot')).cursor;
    const jobCustomer = { id: 'server-job-customer', name: '服务端任务客户', province: '浙江', sales_status: '新客户', approval: '待确认', source: '批量导入', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const jobCapture = { id: 'server-job-capture', customerId: jobCustomer.id, name: jobCustomer.name, source: '批量导入', confirmed: false, createdAt: jobCustomer.createdAt };
    const createdJob = await api(registered.token, 'POST', '/api/sync/jobs', {
      jobId: 'complete-server-job-test', operation: 'import', priority: 40,
      batches: [{ batchIndex: 0, payload: { importId: 'complete-server-job-import', batchIndex: 0, totalBatches: 1, customers: [jobCustomer], captures: [jobCapture] } }]
    }, 202);
    assert.equal(createdJob.created, true, '完整后台任务应一次登记成功');
    await waitFor(async () => (await api(registered.token, 'GET', '/api/sync/jobs/complete-server-job-test')).status === 'completed');
    const jobChanges = await api(registered.token, 'GET', `/api/sync/changes?cursor=${jobCursor}`);
    const jobWorkspaceEvent = jobChanges.events.find(event => event.action === 'workspace.updated' && event.payload?.source === 'customer_import');
    assert.ok(jobWorkspaceEvent?.payload?.patch?.arrays?.customers?.add?.some(item => item.id === jobCustomer.id), '团队事件应携带可直接应用的客户增量');
    assert.deepEqual(jobWorkspaceEvent.payload.privateArrays, [], '待确认客户导入不应生成采集数据');
    await api(registered.token, 'POST', '/api/sync/jobs', {
      jobId: 'worker-status-changed-delete', operation: 'delete', priority: 40,
      batches: [{ batchIndex: 0, payload: { importId: 'worker-status-changed-delete', batchIndex: 0, totalBatches: 1, customerIds: [jobCustomer.id] } }]
    }, 202);
    const statusChangedDelete = await waitFor(async () => {
      const status = await api(registered.token, 'GET', '/api/sync/jobs/worker-status-changed-delete');
      return status.status === 'completed' ? status : null;
    });
    assert.equal(statusChangedDelete.accepted, 0, '已变为待确认状态的客户不应按正式客户删除');
    assert.deepEqual(statusChangedDelete.statusChangedIds, [jobCustomer.id], '状态变化客户应单独返回并由前端刷新');
    assert.ok((await api(registered.token, 'GET', '/api/sync/snapshot')).state?.customers?.some(item => item.id === jobCustomer.id), '状态变化客户应继续保留在服务器');

    const directCustomer = { id: 'worker-direct-customer', name: '后台直入客户', province: '江苏', sales_status: '新客户', approval: '待确认', source: '批量导入', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const directCapture = { id: 'worker-direct-capture', customerId: directCustomer.id, name: directCustomer.name, source: '批量导入', confirmed: false, createdAt: directCustomer.createdAt };
    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-direct-import-test', operation: 'directImport', batchIndex: 0, totalBatches: 1,
      payload: {
        import: { importId: 'worker-direct-import', batchIndex: 0, totalBatches: 1, customers: [directCustomer], captures: [directCapture] },
        promote: { importId: 'worker-direct-promote', batchIndex: 0, totalBatches: 1, customerIds: [directCustomer.id] }
      }
    }, 202);
    await waitFor(async () => (await api(registered.token, 'GET', '/api/sync/snapshot')).state?.customers?.some(item => item.id === directCustomer.id && item.approval === '正式'));

    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-promote-test', operation: 'promote', batchIndex: 0, totalBatches: 1,
      payload: { importId: 'worker-promote', batchIndex: 0, totalBatches: 1, customerIds: [workerCustomer.id] }
    }, 202);
    await waitFor(async () => (await api(registered.token, 'GET', '/api/sync/snapshot')).state?.customers?.some(item => item.id === workerCustomer.id && item.approval === '正式'));

    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-delete-test', operation: 'delete', batchIndex: 0, totalBatches: 1,
      payload: { importId: 'worker-delete', batchIndex: 0, totalBatches: 1, customerIds: [workerCustomer.id] }
    }, 202);
    await waitFor(async () => !(await api(registered.token, 'GET', '/api/sync/snapshot')).state?.customers?.some(item => item.id === workerCustomer.id));
    const customerDeleteStatus = await api(registered.token, 'GET', '/api/sync/jobs/worker-delete-test');
    assert.equal(customerDeleteStatus.accepted, 1, '首次客户删除应成功');
    await api(registered.token, 'POST', '/api/sync/jobs', {
      jobId: 'worker-delete-repeat', operation: 'delete', priority: 40,
      batches: [{ batchIndex: 0, payload: { importId: 'worker-delete-repeat', batchIndex: 0, totalBatches: 1, customerIds: [workerCustomer.id] } }]
    }, 202);
    const repeatedCustomerDelete = await waitFor(async () => {
      const status = await api(registered.token, 'GET', '/api/sync/jobs/worker-delete-repeat');
      return status.status === 'completed' ? status : null;
    });
    assert.deepEqual(repeatedCustomerDelete.alreadyAbsentIds, [workerCustomer.id], '重复删除客户应明确归类为已不存在');

    const firstPart = { arrays: { customers: { update: [{ id: 'customer-a', fields: { remark: '多批次第一批' } }] } } };
    const secondPart = { arrays: { customers: { update: [{ id: 'customer-a', fields: { remark: '多批次第二批' } }] } } };
    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-multipart-test', operation: 'patch', batchIndex: 0, totalBatches: 2,
      payload: { operationId: 'worker-multipart', batchIndex: 0, totalBatches: 2, baseVersion: updated.version, patch: firstPart, requestId: 'worker-multipart-0' }
    }, 202);
    const activeJobs = await api(registered.token, 'GET', '/api/sync/jobs?status=active');
    assert.ok(activeJobs.jobs.some(job => job.jobId === 'worker-multipart-test'), '服务端应暴露尚未登记完的持久化任务状态');
    await waitFor(async () => (await api(registered.token, 'GET', '/api/sync/snapshot')).state?.customers?.find(item => item.id === 'customer-a')?.remark === '多批次第一批');
    await api(registered.token, 'POST', '/api/sync/queue', {
      queueId: 'worker-multipart-test', operation: 'patch', batchIndex: 1, totalBatches: 2,
      payload: { operationId: 'worker-multipart', batchIndex: 1, totalBatches: 2, baseVersion: updated.version, patch: secondPart, requestId: 'worker-multipart-1' }
    }, 202);
    await waitFor(async () => (await api(registered.token, 'GET', '/api/sync/snapshot')).state?.customers?.find(item => item.id === 'customer-a')?.remark === '多批次第二批');
    await api(registered.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'queue-out-of-order', batchIndex: 0, totalBatches: 1, baseVersion: bootstrap.version, patch: {}
    }, 409);
    console.log('Sync queue integration tests passed');
  } catch (error) {
    console.error(error.stack || error);
    console.error(logs);
    process.exitCode = 1;
  } finally {
    db?.close();
    child.kill('SIGTERM');
  }
})();
