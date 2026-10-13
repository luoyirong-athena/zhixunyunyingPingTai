#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const serverDir = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixun-team-sync-'));
const dbPath = path.join(tempDir, 'test.db');
const materialsDir = path.join(tempDir, 'materials');
const port = 3200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let logs = '';

const child = spawn(process.execPath, ['src/index.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(port),
    JWT_SECRET: 'team-sync-integration-test-secret',
    ADMIN_DEFAULT_PASSWORD: 'demo123',
    ZHIXUN_DB_PATH: dbPath,
    ZHIXUN_MATERIALS_DIR: materialsDir,
    NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForServer() {
  for (let i = 0; i < 900; i += 1) {
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
  let payload;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else {
    payload = body;
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

async function waitForSseEvent(token, cursor, action, trigger) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${base}/api/sync/events?cursor=${cursor}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const triggerPromise = Promise.resolve().then(trigger);
    while (Date.now() - startedAt < 3200) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        if (block.includes(`event: ${action}`)) {
          await triggerPromise;
          return Date.now() - startedAt;
        }
      }
    }
    await triggerPromise;
    throw new Error(`3 秒内未收到 SSE 事件 ${action}`);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

(async () => {
  try {
    await waitForServer();
    const alice = await register('alice');
    const bob = await register('bob');
    const charlie = await register('charlie');

    const db = new Database(dbPath);
    const team = db.prepare("SELECT * FROM teams WHERE code='operations-default'").get();
    assert.equal(team.name, '运营团队');
    const members = db.prepare('SELECT tm.*, u.username FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY u.id').all(team.id);
    assert.ok(members.some((row) => row.username === 'alice'));
    assert.ok(members.some((row) => row.username === 'bob'));
    assert.ok(members.some((row) => row.username === 'charlie'), '新用户应由触发器自动加入固定团队');

    const initialState = {
      version: 2,
      customers: [{ id: 'shared-1', name: '共享客户', province: '广西', city: '南宁', sales_status: '新客户', statusHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      tasks: [{ id: 'task-alice-legacy-1', title: 'Alice 旧待办任务', type: '运营计划', status: '待处理', createdAt: new Date().toISOString() }], feedback: [], chats: [], captures: [{ id: 'capture-alice-1', sessionId: 'capture-session-test', name: 'Alice 采集客户', douyin_id: 'alice-douyin-1', createdAt: new Date().toISOString() }], experiences: [], scripts: [], materials: [], logs: [], statuses: [], settings: {}
    };
    const aliceSnapshot0 = (await api(alice.token, 'GET', '/api/sync/snapshot')).data;
    assert.equal(aliceSnapshot0.initialized, false);
    const bootstrap = (await api(alice.token, 'POST', '/api/sync/bootstrap', { state: initialState }, { 'X-Request-Id': 'bootstrap-test-1' }, 201)).data;
    assert.equal(bootstrap.version, 1);
    assert.equal(bootstrap.state.customers[0].name, '共享客户');
    assert.equal(bootstrap.state.captures.length, 1);
    assert.equal(bootstrap.state.captures[0].created_by_user_id, alice.user.id, '旧采集记录迁移时应归属执行迁移的用户');
    assert.equal(bootstrap.state.tasks[0].created_by_user_id, alice.user.id, '旧任务迁移时应归属执行迁移的用户');

    const bobSnapshot = (await api(bob.token, 'GET', '/api/sync/snapshot')).data;
    assert.equal(bobSnapshot.state.customers[0].name, '共享客户', '用户 B 应看到用户 A 迁移的团队数据');
    assert.equal(bobSnapshot.team.id, bootstrap.team.id);
    assert.equal(bobSnapshot.state.tasks.length, 1, '用户 B 的“全部”任务数据应包含用户 A 的任务');
    assert.equal(bobSnapshot.state.tasks[0].created_by_user_id, alice.user.id);
    assert.equal(bobSnapshot.state.captures.length, 0, '用户 B 不应看到用户 A 的客户采集记录');

    const changedState = JSON.parse(JSON.stringify(bootstrap.state));
    changedState.customers[0].sales_status = '高意向';
    changedState.customers[0].updatedAt = new Date().toISOString();
    let statusPut;
    const sseDelay = await waitForSseEvent(bob.token, bootstrap.cursor, 'customer.status_changed', async () => {
      statusPut = (await api(alice.token, 'PUT', '/api/sync/state', {
        state: changedState,
        baseVersion: bootstrap.version
      }, { 'X-Request-Id': 'workspace-status-change-1' })).data;
    });
    assert.ok(sseDelay < 3000, `SSE 推送耗时 ${sseDelay}ms`);
    assert.equal(statusPut.version, 2);
    assert.equal(statusPut.state.customers[0].sales_status, '高意向');
    assert.equal(statusPut.state.customers[0].statusHistory.at(-1).operatorUserId, alice.user.id);

    const repeat = (await api(alice.token, 'PUT', '/api/sync/state', {
      state: changedState,
      baseVersion: bootstrap.version
    }, { 'X-Request-Id': 'workspace-status-change-1' })).data;
    assert.equal(repeat.version, 2, '相同请求号应返回幂等结果而不是重复写入');

    const stale = await api(bob.token, 'PUT', '/api/sync/state', {
      state: initialState,
      baseVersion: 1
    }, { 'X-Request-Id': 'stale-write-1' }, 409);
    assert.equal(stale.data.version, 2);

    const changes = (await api(bob.token, 'GET', `/api/sync/changes?cursor=${bootstrap.cursor}`)).data;
    const statusEvent = changes.events.find((event) => event.action === 'customer.status_changed');
    assert.ok(statusEvent, '增量同步应包含销售状态事件');
    assert.equal(statusEvent.payload.delta.after.sales_status, '高意向', '实体事件应携带可直接应用的增量数据');
    const workspaceHistory = (await api(bob.token, 'GET', '/api/sync/status-history?customer_id=shared-1')).data;
    assert.equal(workspaceHistory.filter((row) => row.request_id === 'workspace-status-change-1').length, 1, '销售状态历史不得重复');
    assert.equal(workspaceHistory.find((row) => row.request_id === 'workspace-status-change-1').operator_user_id, alice.user.id);

    const bobCaptureState = JSON.parse(JSON.stringify((await api(bob.token, 'GET', '/api/sync/snapshot')).data.state));
    bobCaptureState.captures.push({ id: 'capture-bob-1', sessionId: 'capture-session-test', name: 'Bob 采集客户', douyin_id: 'bob-douyin-1', createdAt: new Date().toISOString() });
    bobCaptureState.tasks.push({ id: 'task-bob-1', title: 'Bob 待办任务', type: '微信沟通', status: '待处理', createdAt: new Date().toISOString() });
    const bobCapturePut = (await api(bob.token, 'PUT', '/api/sync/state', {
      state: bobCaptureState,
      baseVersion: statusPut.version
    }, { 'X-Request-Id': 'workspace-bob-capture-1' })).data;
    assert.equal(bobCapturePut.version, 3);
    assert.deepEqual(bobCapturePut.state.captures.map((row) => row.id), ['capture-bob-1']);
    assert.equal(bobCapturePut.state.captures[0].created_by_user_id, bob.user.id);
    assert.deepEqual(bobCapturePut.state.tasks.map((row) => row.id).sort(), ['task-alice-legacy-1', 'task-bob-1']);
    assert.equal(bobCapturePut.state.tasks.find((row) => row.id === 'task-alice-legacy-1').created_by_user_id, alice.user.id);
    assert.equal(bobCapturePut.state.tasks.find((row) => row.id === 'task-bob-1').created_by_user_id, bob.user.id);

    const aliceAfterBobCapture = (await api(alice.token, 'GET', '/api/sync/snapshot')).data;
    assert.deepEqual(aliceAfterBobCapture.state.captures.map((row) => row.id), ['capture-alice-1'], '用户 A 不应看到用户 B 的客户采集记录');
    assert.deepEqual(aliceAfterBobCapture.state.tasks.map((row) => row.id).sort(), ['task-alice-legacy-1', 'task-bob-1'], '团队任务快照应向所有成员返回全部任务');
    aliceAfterBobCapture.state.captures.push({ id: 'capture-alice-2', sessionId: 'capture-session-test', name: 'Alice 第二条采集', createdAt: new Date().toISOString() });
    const aliceCapturePut = (await api(alice.token, 'PUT', '/api/sync/state', {
      state: aliceAfterBobCapture.state,
      baseVersion: aliceAfterBobCapture.version
    }, { 'X-Request-Id': 'workspace-alice-capture-2' })).data;
    assert.equal(aliceCapturePut.version, 4);
    assert.deepEqual(aliceCapturePut.state.captures.map((row) => row.id).sort(), ['capture-alice-1', 'capture-alice-2']);

    const duplicateCaptureState = JSON.parse(JSON.stringify(aliceCapturePut.state));
    duplicateCaptureState.captures.push({
      id: 'capture-alice-duplicate-phone',
      name: 'Alice 采集客户（更新）',
      phone: '13900000001',
      douyin_id: 'alice-douyin-1',
      wechat_id: 'alice-new-wechat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() + 1000).toISOString()
    });
    duplicateCaptureState.captures[0].phone = '13900000001';
    const aliceCaptureMerge = (await api(alice.token, 'PUT', '/api/sync/state', {
      state: duplicateCaptureState,
      baseVersion: aliceCapturePut.version
    }, { 'X-Request-Id': 'workspace-alice-capture-merge-1' })).data;
    assert.equal(aliceCaptureMerge.state.captures.length, 2, '重复采集客户应合并而不是新增一行');
    const mergedAliceCapture = aliceCaptureMerge.state.captures.find((row) => row.id === 'capture-alice-1');
    assert.equal(mergedAliceCapture.name, 'Alice 采集客户（更新）');
    assert.equal(mergedAliceCapture.wechat_id, 'alice-new-wechat', '重复识别出的新字段应更新到原记录');

    const channelCaptureState = JSON.parse(JSON.stringify(aliceCaptureMerge.state));
    channelCaptureState.captures.push({
      id: 'capture-alice-channel-1',
      platform: 'wechat-channel',
      name: 'Alice 视频号',
      channel_account: 'Alice视频号',
      createdAt: new Date().toISOString()
    });
    const aliceChannelPut = (await api(alice.token, 'PUT', '/api/sync/state', {
      state: channelCaptureState,
      baseVersion: aliceCaptureMerge.version
    }, { 'X-Request-Id': 'workspace-alice-channel-1' })).data;
    const duplicateChannelState = JSON.parse(JSON.stringify(aliceChannelPut.state));
    duplicateChannelState.captures.push({
      id: 'capture-alice-channel-duplicate',
      platform: 'wechat-channel',
      name: 'Alice 视频号',
      channel_account: 'Alice 视频号',
      phone: '13900139000',
      createdAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() + 1000).toISOString()
    });
    const aliceChannelMerge = (await api(alice.token, 'PUT', '/api/sync/state', {
      state: duplicateChannelState,
      baseVersion: aliceChannelPut.version
    }, { 'X-Request-Id': 'workspace-alice-channel-merge-1' })).data;
    assert.equal(aliceChannelMerge.state.captures.filter((row) => row.channel_account).length, 1, '视频号重复记录应按账号合并');
    assert.equal(aliceChannelMerge.state.captures.find((row) => row.channel_account)?.phone, '13900139000');

    const pastedCaptureCreatedAt = new Date().toISOString();
    const alicePastedCapture = (await api(alice.token, 'POST', '/api/sync/upsert-captures', {
      captures: [{
        id: 'capture-alice-paste-1',
        name: 'Alice 粘贴识别客户',
        douyin_id: 'alice-paste-douyin-1',
        created_by_user_id: bob.user.id,
        createdAt: pastedCaptureCreatedAt,
        updatedAt: pastedCaptureCreatedAt
      }]
    }, { 'X-Request-Id': 'capture-alice-paste-1' }, 201)).data;
    assert.ok(alicePastedCapture.captures.some((row) => row.id === 'capture-alice-paste-1'), '粘贴识别应立即写入服务端');
    assert.equal(alicePastedCapture.captures.find((row) => row.id === 'capture-alice-paste-1')?.created_by_user_id, alice.user.id, '采集记录归属必须以当前登录用户为准');
    const alicePastedReplay = (await api(alice.token, 'POST', '/api/sync/upsert-captures', {
      captures: [{ id: 'capture-alice-paste-1', name: 'Alice 粘贴识别客户', douyin_id: 'alice-paste-douyin-1', createdAt: pastedCaptureCreatedAt }]
    }, { 'X-Request-Id': 'capture-alice-paste-1' })).data;
    assert.equal(alicePastedReplay.version, alicePastedCapture.version, '相同粘贴请求不得重复写入');
    assert.equal(alicePastedReplay.replayed, true, '相同粘贴请求应返回幂等结果');
    const alicePastedDuplicate = (await api(alice.token, 'POST', '/api/sync/upsert-captures', {
      captures: [{
        id: 'capture-alice-paste-duplicate',
        name: 'Alice 粘贴识别客户（补全）',
        douyin_id: 'alice-paste-douyin-1',
        phone: '13700137000',
        createdAt: new Date().toISOString(),
        updatedAt: new Date(Date.now() + 1000).toISOString()
      }]
    }, { 'X-Request-Id': 'capture-alice-paste-merge-1' })).data;
    assert.equal(alicePastedDuplicate.accepted, 0, '重复识别不应新增记录');
    assert.equal(alicePastedDuplicate.duplicateSkipped, 1, '重复识别应被跳过');
    const pastedMatches = alicePastedDuplicate.captures.filter((row) => row.douyin_id === 'alice-paste-douyin-1');
    assert.equal(pastedMatches.length, 1, '重复识别应只保留原采集记录');
    assert.equal(pastedMatches[0].id, 'capture-alice-paste-1', '重复识别应保留原采集记录');
    assert.equal(pastedMatches[0].phone, undefined, '重复识别不得覆盖或补全原记录');

    const aliceChannelSameText = (await api(alice.token, 'POST', '/api/sync/upsert-captures', {
      captures: [{
        id: 'capture-alice-channel-same-text',
        name: 'Alice 视频号客户',
        platform: 'wechat-channel',
        channel_account: 'alice-paste-douyin-1',
        phone: '13700137000',
        createdAt: new Date().toISOString()
      }]
    }, { 'X-Request-Id': 'capture-alice-channel-same-text-1' }, 201)).data;
    assert.equal(aliceChannelSameText.accepted, 1, '不同平台的相同账号文本不应互相判重');

    const aliceBatchDuplicates = (await api(alice.token, 'POST', '/api/sync/upsert-captures', {
      captures: [
        { id: 'capture-alice-batch-douyin-1', douyin_id: 'alice-batch-douyin-1', name: '批次抖音一' },
        { id: 'capture-alice-batch-douyin-2', douyin_id: 'alice-batch-douyin-1', name: '批次抖音二' },
        { id: 'capture-alice-batch-channel-1', platform: 'wechat-channel', channel_account: 'alice-batch-channel-1', name: '批次视频号一' },
        { id: 'capture-alice-batch-channel-2', platform: 'wechat-channel', channel_account: 'alice-batch-channel-1', name: '批次视频号二' }
      ]
    }, { 'X-Request-Id': 'capture-alice-batch-duplicates-1' }, 201)).data;
    assert.equal(aliceBatchDuplicates.accepted, 2, '同一请求中的平台账号重复项只应新增一条');
    assert.equal(aliceBatchDuplicates.duplicateSkipped, 2, '同一请求中的重复项应被跳过');
    assert.equal(aliceBatchDuplicates.captures.filter((row) => row.douyin_id === 'alice-batch-douyin-1').length, 1, '同批抖音重复项应只保留一条');
    assert.equal(aliceBatchDuplicates.captures.filter((row) => row.channel_account === 'alice-batch-channel-1').length, 1, '同批视频号重复项应只保留一条');
    const aliceAfterPastedRefresh = (await api(alice.token, 'GET', '/api/sync/snapshot')).data;
    assert.ok(aliceAfterPastedRefresh.state.captures.some((row) => row.id === 'capture-alice-paste-1'), '刷新后应恢复已粘贴识别的采集记录');

    const promotedPastedCapture = (await api(alice.token, 'POST', '/api/sync/promote-capture-batch', {
      importId: 'capture-alice-promote-1',
      batchIndex: 0,
      totalBatches: 1,
      captureIds: ['capture-alice-paste-1']
    }, { 'X-Request-Id': 'capture-alice-promote-1' }, 201)).data;
    assert.equal(promotedPastedCapture.accepted, 1, '客户采集加入客户库应成功处理记录');
    assert.ok(promotedPastedCapture.acceptedCaptureIds.includes('capture-alice-paste-1'), '加入客户库应返回成功处理的采集记录');
    const promotedPastedCustomerId = promotedPastedCapture.acceptedIds[0];
    assert.ok(promotedPastedCustomerId, '加入客户库应返回新客户编号');
    const aliceAfterCapturePromotion = (await api(alice.token, 'GET', '/api/sync/snapshot')).data;
    assert.ok(!aliceAfterCapturePromotion.state.captures.some((row) => row.id === 'capture-alice-paste-1'), '加入客户库后采集记录应从客户采集中移除');
    assert.ok(aliceAfterCapturePromotion.state.customers.some((row) => row.id === promotedPastedCustomerId), '加入客户库后正式客户应持久保存');

    const resurrectedCapture = {
      id: 'capture-alice-paste-1', name: 'Alice 粘贴识别客户（延迟回写）',
      douyin_id: 'alice-paste-douyin-1', created_by_user_id: alice.user.id,
      createdBy: 'alice', created_by_username: 'alice', createdAt: new Date().toISOString()
    };
    const delayedRecognition = (await api(alice.token, 'POST', '/api/sync/upsert-captures', {
      captures: [resurrectedCapture]
    }, { 'X-Request-Id': 'capture-alice-paste-resurrection-1' }, 200)).data;
    assert.equal(delayedRecognition.captures.some((row) => row.id === resurrectedCapture.id), false, '已转入客户库的采集记录不得被延迟识别请求复活');

    const reidentifiedCapture = {
      ...resurrectedCapture,
      id: 'capture-alice-paste-reidentified-1',
      name: 'Alice 粘贴识别客户（新编号回流）'
    };
    const delayedReidentification = (await api(alice.token, 'POST', '/api/sync/upsert-captures', {
      captures: [reidentifiedCapture]
    }, { 'X-Request-Id': 'capture-alice-paste-reidentified-1' }, 200)).data;
    assert.equal(delayedReidentification.accepted, 0, '已转入客户库的相同强标识记录不得以新编号再次加入客户采集');
    assert.equal(delayedReidentification.captures.some((row) => row.id === reidentifiedCapture.id), false, '强标识相同的新编号采集记录不得回流');

    const staleWorkspaceState = JSON.parse(JSON.stringify(aliceAfterCapturePromotion.state));
    staleWorkspaceState.capturePromotionTombstones = [];
    staleWorkspaceState.customers = staleWorkspaceState.customers
      .filter((row) => row.id !== promotedPastedCustomerId);
    staleWorkspaceState.captures.push(resurrectedCapture);
    const staleWorkspaceWrite = (await api(alice.token, 'PUT', '/api/sync/state', {
      state: staleWorkspaceState,
      baseVersion: delayedReidentification.version
    }, { 'X-Request-Id': 'workspace-alice-capture-resurrection-1' })).data;
    assert.equal(staleWorkspaceWrite.state.captures.some((row) => row.id === resurrectedCapture.id), false, '旧页面保存完整状态时不得恢复已转入客户库的采集记录');
    assert.ok(staleWorkspaceWrite.state.customers.some((row) => row.id === promotedPastedCustomerId), '旧页面保存完整状态时不得删除已转入的正式客户');
    const persistedTombstone = staleWorkspaceWrite.state.capturePromotionTombstones.find((item) => item.id === resurrectedCapture.id);
    assert.ok(persistedTombstone?.identityKeys?.includes('douyin:alice-paste-douyin-1'), '旧页面不得覆盖已保存的强标识防回流信息');
    assert.equal(String(persistedTombstone?.ownerId), String(alice.user.id), '旧页面不得覆盖防回流标记的用户归属');

    const workspaceEventsBeforeNoop = db.prepare("SELECT COUNT(*) count FROM sync_events WHERE team_id = ? AND action = 'workspace.updated'").get(team.id).count;
    const noopPut = (await api(alice.token, 'PUT', '/api/sync/state', {
      state: staleWorkspaceWrite.state,
      baseVersion: staleWorkspaceWrite.version
    }, { 'X-Request-Id': 'workspace-alice-noop-1' })).data;
    assert.equal(noopPut.version, staleWorkspaceWrite.version, '相同工作区内容不得继续递增数据版本');
    const workspaceEventsAfterNoop = db.prepare("SELECT COUNT(*) count FROM sync_events WHERE team_id = ? AND action = 'workspace.updated'").get(team.id).count;
    assert.equal(workspaceEventsAfterNoop, workspaceEventsBeforeNoop, '相同工作区内容不得重复发送同步事件');

    const bobAfterAliceCapture = (await api(bob.token, 'GET', '/api/sync/snapshot')).data;
    assert.deepEqual(bobAfterAliceCapture.state.captures.map((row) => row.id), ['capture-bob-1'], '用户 A 保存自己的局部快照时不得删除或泄露用户 B 的采集记录');
    const rawWorkspaceState = JSON.parse(db.prepare('SELECT state_json FROM workspace_states WHERE team_id = ?').get(team.id).state_json);
    assert.deepEqual(rawWorkspaceState.captures.map((row) => row.id).sort(), [
      'capture-alice-1', 'capture-alice-2', 'capture-alice-batch-channel-1',
      'capture-alice-batch-douyin-1', 'capture-alice-channel-1',
      'capture-alice-channel-same-text', 'capture-bob-1'
    ]);
    assert.deepEqual([...new Set(rawWorkspaceState.captures.map((row) => row.created_by_user_id))].sort(), [alice.user.id, bob.user.id].sort());
    assert.deepEqual(rawWorkspaceState.tasks.map((row) => row.id).sort(), ['task-alice-legacy-1', 'task-bob-1'], '保存个人采集数据不得删除团队任务');
    assert.deepEqual([...new Set(rawWorkspaceState.tasks.map((row) => row.created_by_user_id))].sort(), [alice.user.id, bob.user.id].sort());

    const customer = (await api(alice.token, 'POST', '/api/customers', {
      name: '接口共享客户', province: '广西', city: '南宁', sales_status: '新客户', phone: '13900000001', qq: '0012345'
    })).data;
    await api(alice.token, 'POST', '/api/scraper/parse-url', { url: 'http://127.0.0.1/internal' }, {}, 400);
    await api(alice.token, 'POST', '/api/scraper/parse-url', { url: 'https://example.com/not-douyin' }, {}, 400);
    await api(alice.token, 'POST', '/api/functions/ocr', { model: 'unapproved-model', image: 'data:image/png;base64,AA==' }, {}, 400);
    assert.equal(customer.created_by_user_id, alice.user.id);
    assert.equal(customer.qq, '0012345', 'QQ 号应按文本保存并保留前导零');
    const legacyImport = (await api(alice.token, 'POST', '/api/data/import', {
      customers: [
        { id: customer.id, name: '接口共享客户已更新', sales_status: '已联系', phone: customer.phone, qq: '0006789', province: '', notes: '旧接口覆盖备注' },
        { name: '旧接口新增客户', phone: '13900000002', qq: '0002468', sales_status: '新客户' }
      ]
    })).data;
    assert.equal(legacyImport.results.updated_customers, 1, '旧版备份接口应更新匹配客户');
    assert.equal(legacyImport.results.added_customers, 1, '旧版备份接口应新增未匹配客户');
    customer.name = '接口共享客户已更新';
    const updatedCustomerFromLegacyImport = (await api(alice.token, 'GET', `/api/customers/${customer.id}`)).data;
    assert.equal(updatedCustomerFromLegacyImport.name, '接口共享客户已更新');
    assert.equal(updatedCustomerFromLegacyImport.sales_status, '已联系');
    assert.equal(updatedCustomerFromLegacyImport.qq, '0006789', '旧版备份导入应更新 QQ 号并保留前导零');
    assert.equal(updatedCustomerFromLegacyImport.province, '广西', '空省份不应覆盖原值');
    await api(alice.token, 'POST', '/api/data/import', {
      customers: [{ id: customer.id, name: '接口共享客户已更新', phone: customer.phone, notes: '只更新备注' }]
    });
    const preservedStatus = (await api(alice.token, 'GET', `/api/customers/${customer.id}`)).data;
    assert.equal(preservedStatus.sales_status, '已联系', '备份缺少销售状态时不得覆盖原值');
    const bobCustomers = (await api(bob.token, 'GET', '/api/customers?search=' + encodeURIComponent('接口共享客户已更新'))).data;
    assert.equal(bobCustomers.total, 1);
    const qqSearch = (await api(bob.token, 'GET', '/api/customers?search=' + encodeURIComponent('0006789'))).data;
    assert.equal(qqSearch.total, 1, '客户接口应支持按 QQ 号搜索');
    // Legacy customer writes must already be present in the authoritative
    // workspace snapshot; the permission API reads that snapshot after refresh.
    const permissionStateRow = db.prepare('SELECT state_json FROM workspace_states WHERE team_id = ?').get(team.id);
    const permissionState = JSON.parse(permissionStateRow.state_json);
    assert.ok(permissionState.customers.some(item => String(item.id) === String(customer.id)), '旧客户接口写入后刷新不得丢失');
    await api(bob.token, 'POST', '/api/data/import', {
      customers: [{ id: customer.id, name: '无权限导入覆盖', phone: customer.phone }]
    }, {}, 403);
    const evidence = (await api(alice.token, 'POST', `/api/customers/${customer.id}/evidence`, {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0XQAAAABJRU5ErkJggg=='
    }, {}, 201)).data;
    await api(bob.token, 'DELETE', `/api/customers/${customer.id}/evidence/${evidence.id}`, undefined, {}, 403);
    await api(alice.token, 'POST', '/api/tasks', { title: '错误关联任务', customer_id: 999999 }, {}, 400);
    await api(alice.token, 'POST', '/api/feedback', { content: '错误关联反馈', customer_id: 999999 }, {}, 400);
    const permissionRequest = (await api(bob.token, 'POST', '/api/data-permissions/request', {
      customerId: String(customer.id),
      reason: '团队协作编辑测试'
    }, {}, 201)).data;
    assert.equal(permissionRequest.status, 'pending');
    const approvedPermission = (await api(alice.token, 'PATCH', `/api/data-permissions/${permissionRequest.id}`, {
      action: 'approve',
      note: '测试授权'
    })).data;
    assert.equal(approvedPermission.status, 'approved');
    const updatedCustomer = (await api(bob.token, 'PUT', `/api/customers/${customer.id}`, { sales_status: '高意向' })).data;
    assert.equal(updatedCustomer.updated_by_user_id, bob.user.id);
    const detail = (await api(alice.token, 'GET', `/api/customers/${customer.id}`)).data;
    assert.ok(detail.status_history.some((row) => row.to_status === '高意向' && row.operator_user_id === bob.user.id));

    const task = (await api(alice.token, 'POST', '/api/tasks', { title: '共享任务', customer_id: customer.id, status: '待办' })).data;
    assert.equal((await api(bob.token, 'PUT', `/api/tasks/${task.id}`, { status: '已完成' })).data.status, '已完成');
    assert.equal((await api(alice.token, 'PUT', `/api/tasks/${task.id}`, { status: '待办' })).data.status, '待办');

    const creations = [
      ['/api/feedback', { customer_id: customer.id, customer_name: customer.name, issue_type: '其他', content: '共享反馈' }],
      ['/api/experiences', { title: '共享经验', content: '经验内容', category: '测试' }],
      ['/api/tags', { name: '共享标签', category: '资料' }],
      ['/api/chat-records', { customer_id: customer.id, file_name: 'chat.txt', messages: [{ text: 'hello' }] }],
      ['/api/product-requests', { title: '共享产品需求' }]
    ];
    const createdLegacyIds = {};
    for (const [endpoint, body] of creations) {
      const created = (await api(alice.token, 'POST', endpoint, body)).data;
      assert.ok(created.id, `${endpoint} 创建失败`);
      createdLegacyIds[endpoint] = String(created.id);
      const listing = (await api(bob.token, 'GET', endpoint)).data;
      const rows = Array.isArray(listing) ? listing : listing.data;
      assert.ok(rows.some((row) => row.id === created.id), `${endpoint} 未按团队共享`);
    }

    const legacySnapshot = (await api(bob.token, 'GET', '/api/sync/snapshot')).data.state;
    for (const [endpoint, collection] of [
      ['/api/feedback', 'feedback'], ['/api/experiences', 'experiences'], ['/api/tags', 'tags'],
      ['/api/chat-records', 'chats'], ['/api/product-requests', 'productRequests']
    ]) {
      assert.ok((legacySnapshot[collection] || []).some(item => String(item.id) === createdLegacyIds[endpoint]), `${endpoint} 写入后刷新不得丢失`);
    }
    assert.ok(legacySnapshot.tasks.some(item => String(item.id) === String(task.id)), '旧待办接口写入后刷新不得丢失');

    const statusRows = (await api(alice.token, 'GET', '/api/sales-statuses')).data;
    assert.equal(statusRows.length, 10);
    const priorityConfig = {
      weights: { followers: 35, evidence: 25, status: 40 },
      thresholds: { first: 85, second: 65, third: 45 },
      followers: [{ min: 8000, score: 35 }],
      evidence: [{ min: 5, score: 25 }]
    };
    await api(alice.token, 'PUT', '/api/sales-statuses', {
      statuses: statusRows.map((item, index) => ({ ...item, id: `status-${index}` })),
      priorityConfig
    }, { 'X-Request-Id': 'atomic-status-config-1' });
    const configSnapshot = (await api(bob.token, 'GET', '/api/sync/snapshot')).data.state;
    assert.equal(configSnapshot.statuses.length, 10, '销售状态应写入工作区快照');
    assert.deepEqual(configSnapshot.settings.priorityConfig.weights, priorityConfig.weights, '优先级配置应与销售状态在同一事务写入');
    assert.deepEqual(JSON.parse(db.prepare('SELECT priority_config FROM teams WHERE id = ?').get(team.id).priority_config).weights, priorityConfig.weights, '服务端评分配置应与工作区一致');
    const ownLogs = (await api(alice.token, 'GET', '/api/operation-logs?scope=mine&page=1&limit=10')).data;
    const allLogs = (await api(bob.token, 'GET', '/api/operation-logs?scope=all&page=1&limit=10')).data;
    assert.ok(ownLogs.total > 0 && ownLogs.data.every(item => Number(item.userId) === Number(alice.user.id)), '自己的日志筛选应只返回当前用户');
    assert.ok(allLogs.total >= ownLogs.total, '全部日志应包含团队操作');
    assert.equal(allLogs.page, 1);
    assert.equal((await api(bob.token, 'GET', '/api/analytics/dashboard')).data.total, 4);
    assert.equal((await api(bob.token, 'GET', '/api/analytics/summary')).data.customers, 4);

    const imported = (await api(alice.token, 'POST', '/api/data/import', {
      customers: [{ id: 'import-1', name: '导入客户', province: '广西', sales_status: '新客户' }],
      tasks: [], feedback: [], experiences: [], tags: [], product_requests: [], chat_records: [], sales_statuses: [], customer_status_history: []
    }, { 'X-Request-Id': 'import-test-1' })).data;
    assert.equal(imported.results.customers, 1);
    const importedSnapshot = (await api(bob.token, 'GET', '/api/sync/snapshot')).data.state;
    assert.ok(importedSnapshot.customers.some(row => row.name === '导入客户'), '旧版数据导入后刷新不得丢失');
    const exported = (await api(bob.token, 'GET', '/api/data/export')).data;
    assert.ok(exported.customers.some((row) => row.name === '导入客户'));

    const form = new FormData();
    form.append('category', '资料文件');
    form.append('files', new Blob(['team sync material'], { type: 'text/plain' }), 'team-sync.txt');
    const material = (await api(alice.token, 'POST', '/api/materials/upload', form)).data.data[0];
    const materialList = (await api(bob.token, 'GET', '/api/materials')).data.data;
    assert.ok(materialList.some((row) => row.id === material.id));
    await api(bob.token, 'DELETE', `/api/materials/${material.id}`);
    assert.ok(fs.existsSync(material.storage_path), '软删除资料元数据时必须保留原文件');

    db.prepare("UPDATE team_members SET role='viewer' WHERE team_id=? AND user_id=?").run(team.id, bob.user.id);
    assert.equal((await api(bob.token, 'GET', '/api/sync/snapshot')).data.team.role, 'viewer');
    await api(bob.token, 'PUT', '/api/sync/state', { state: statusPut.state, baseVersion: statusPut.version }, { 'X-Request-Id': 'viewer-write-1' }, 403);
    await api(bob.token, 'POST', '/api/customers', { name: '不应创建', province: '广西', sales_status: '新客户' }, {}, 403);
    db.prepare("UPDATE team_members SET role='member' WHERE team_id=? AND user_id=?").run(team.id, bob.user.id);

    await api(alice.token, 'DELETE', `/api/tasks/${task.id}`);
    await api(bob.token, 'DELETE', `/api/customers/${customer.id}`);
    assert.equal((await api(alice.token, 'GET', `/api/customers/${customer.id}`, undefined, {}, 404)).data.error, '客户不存在');

    const mergeClock = Date.now() + 60 * 1000;
    const remarkOlder = new Date(mergeClock).toISOString();
    const remarkNewer = new Date(mergeClock + 1000).toISOString();
    const statusNewer = new Date(mergeClock + 2000).toISOString();
    const latestSnapshot = (await api(alice.token, 'GET', '/api/sync/snapshot')).data;
    const patchOne = (await api(alice.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'field-merge-1', batchIndex: 0, totalBatches: 1, baseVersion: latestSnapshot.version,
      patch: { replace: {}, arrays: { customers: { add: [], remove: [], update: [{
        id: 'shared-1', fields: { remark: '新备注', updatedAt: remarkNewer, fieldUpdatedAt: { remark: remarkNewer } }
      }] } } }
    }, { 'X-Request-Id': 'field-merge-1' })).data;
    const patchTwo = (await api(bob.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'field-merge-2', batchIndex: 0, totalBatches: 1, baseVersion: latestSnapshot.version,
      patch: { replace: {}, arrays: { customers: { add: [], remove: [], update: [{
        id: 'shared-1', fields: {
          remark: '旧备注不应覆盖', sales_status: '已联系', updatedAt: statusNewer,
          fieldUpdatedAt: { remark: remarkOlder, sales_status: statusNewer }
        }
      }] } } }
    }, { 'X-Request-Id': 'field-merge-2' })).data;
    assert.equal(patchTwo.version, patchOne.version + 1);
    const fieldMergedSnapshot = (await api(alice.token, 'GET', '/api/sync/snapshot')).data;
    const fieldMergedCustomer = fieldMergedSnapshot.state.customers.find((customer) => customer.id === 'shared-1');
    assert.equal(fieldMergedCustomer.remark, '新备注', '旧时间字段不得覆盖已保存备注');
    assert.equal(fieldMergedCustomer.sales_status, '已联系', '较新字段应正常合并');

    await api(alice.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'pet-guide-member-denied', batchIndex: 0, totalBatches: 1,
      baseVersion: fieldMergedSnapshot.version,
      patch: { replace: { settings: { petGuideConfig: [{
        id: 'member-guide', route: '*', action: 'default', title: '无权修改',
        message: '普通成员不能保存该配置', mode: 'beginner', enabled: true, sortOrder: 0
      }] } }, arrays: {} }
    }, { 'X-Request-Id': 'pet-guide-member-denied' }, 403);

    const admin = (await api(null, 'POST', '/api/auth/login', {
      username: 'demo', password: 'demo123'
    })).data;
    const petGuideConfig = [{
      id: 'team-guide-1', route: 'customers', action: 'new-customer', title: '新增客户',
      message: '这里可以手动新增客户到客户库。', mode: 'beginner', enabled: true, sortOrder: 0
    }];
    const adminPetGuideUpdate = (await api(admin.token, 'POST', '/api/sync/patch-batch', {
      operationId: 'pet-guide-admin-update', batchIndex: 0, totalBatches: 1,
      baseVersion: fieldMergedSnapshot.version,
      patch: { replace: { settings: { petGuideConfig } }, arrays: {} }
    }, { 'X-Request-Id': 'pet-guide-admin-update' })).data;
    assert.equal(adminPetGuideUpdate.version, fieldMergedSnapshot.version + 1);
    const memberAfterPetGuideUpdate = (await api(alice.token, 'GET', '/api/sync/snapshot')).data;
    assert.deepEqual(memberAfterPetGuideUpdate.state.settings.petGuideConfig, petGuideConfig,
      'admin 保存桌宠配置后，团队成员下次读取应获得相同配置');

    const nullTeamRows = [];
    for (const tableName of ['customers', 'tasks', 'feedback', 'experiences', 'tags', 'product_requests', 'chat_records', 'sales_statuses', 'customer_status_history', 'materials_files', 'materials_jobs']) {
      const count = db.prepare(`SELECT COUNT(*) count FROM ${tableName} WHERE team_id IS NULL`).get().count;
      if (count) nullTeamRows.push(`${tableName}:${count}`);
    }
    assert.deepEqual(nullTeamRows, []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.ok(db.prepare('SELECT COUNT(*) count FROM operation_logs WHERE team_id=?').get(team.id).count > 0);
    assert.ok(db.prepare("SELECT COUNT(*) count FROM sync_events WHERE team_id=? AND action='customer.status_changed'").get(team.id).count > 0);
    db.close();

    console.log(JSON.stringify({
      result: 'ok',
      teamId: team.id,
      members: members.length,
      sseDelayMs: sseDelay,
      workspaceVersion: statusPut.version,
      statusHistory: workspaceHistory.length,
      tempDatabase: dbPath
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error);
    console.error('\n--- server output ---\n' + logs);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(150);
    if (child.exitCode === null) child.kill('SIGKILL');
    if (!process.exitCode) fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
