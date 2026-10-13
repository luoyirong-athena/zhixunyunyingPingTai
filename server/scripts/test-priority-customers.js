#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  parseFollowers,
  followerScore,
  ladderFor,
  computeCustomerPriority,
  getPriorityConfig,
  savePriorityConfig,
  listPriorityCustomers
} = require('../src/services/priorityCustomers');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixun-priority-'));
const dbPath = path.join(tempDir, 'priority.db');
const db = new Database(dbPath);
try {
  assert.equal(parseFollowers('4999'), 4999);
  assert.equal(parseFollowers('5000'), 5000);
  assert.equal(parseFollowers('9999'), 9999);
  assert.equal(parseFollowers('10000'), 10000);
  assert.equal(parseFollowers('1万'), 10000);
  assert.equal(parseFollowers('1.2万'), 12000);
  assert.equal(parseFollowers('2k'), 2000);
  assert.equal(parseFollowers(''), 0);
  assert.equal(followerScore(4999), 0);
  assert.equal(followerScore(5000), 20);
  assert.equal(followerScore(10000), 40);
  assert.equal(ladderFor(80).key, 'first');
  assert.equal(ladderFor(60).key, 'second');
  assert.equal(ladderFor(40).key, 'third');
  assert.equal(ladderFor(39).key, 'cultivate');

  db.exec(`
    CREATE TABLE teams (id INTEGER PRIMARY KEY, priority_config TEXT, updated_at TEXT);
    CREATE TABLE workspace_states (team_id INTEGER PRIMARY KEY, state_json TEXT, version INTEGER);
    CREATE TABLE customer_evidence (
      id INTEGER PRIMARY KEY, team_id INTEGER, customer_id TEXT, evidence_type TEXT,
      deleted_at TEXT
    );
    CREATE TABLE sales_statuses (
      id INTEGER PRIMARY KEY, team_id INTEGER, name TEXT, priority_enabled INTEGER,
      priority_score INTEGER, priority_excluded INTEGER, deleted_at TEXT, is_enabled INTEGER
    );
  `);
  const teamId = 1;
  db.prepare('INSERT INTO teams (id, priority_config) VALUES (?, NULL)').run(teamId);
  const customers = [
    { id: 'a', name: '五千粉客户', approval: '正式', douyin_followers: '5000', sales_status: '新客户', updatedAt: '2026-08-04T10:00:00Z' },
    { id: 'b', name: '一万粉客户', approval: '正式', douyin_followers: '1万', sales_status: '高意向', updatedAt: '2026-08-04T11:00:00Z' },
    { id: 'c', name: '有截图客户', approval: '正式', douyin_followers: '0', sales_status: '新客户' },
    { id: 'pending', name: '待确认', approval: '待确认', douyin_followers: '10000', sales_status: '高意向' },
    { id: 'deleted', name: '已删除', approval: '正式', deletedAt: '2026-08-04T12:00:00Z', sales_status: '新客户' },
    { id: 'paid', name: '已付费', approval: '正式', douyin_followers: '10000', sales_status: '已付费' },
    { id: 'dup', name: '重复第一条', approval: '正式', douyin_followers: '10000', sales_status: '高意向' },
    { id: 'dup', name: '重复第二条', approval: '正式', douyin_followers: '1', sales_status: '新客户' }
  ];
  db.prepare('INSERT INTO workspace_states VALUES (?, ?, ?)').run(teamId, JSON.stringify({ customers }), 7);
  const insertEvidence = db.prepare('INSERT INTO customer_evidence VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= 6; i += 1) insertEvidence.run(i, teamId, 'c', 'moments_order_screenshot', null);
  insertEvidence.run(99, teamId, 'c', 'moments_order_screenshot', '2026-08-04 12:00:00');
  db.prepare('INSERT INTO sales_statuses VALUES (1, ?, ?, 1, 25, 0, NULL, 1)').run(teamId, '新客户');

  const result = listPriorityCustomers(db, teamId, { limit: 100 });
  assert.equal(result.total, 4, '只应返回正式、未删除、未排除且去重后的客户');
  assert.equal(result.ladderCounts.second, 2, '高意向一万粉客户应进入第二梯队');
  assert.equal(result.customers.find(item => item.customerId === 'c').evidenceCount, 6, '软删除截图不应计入');
  assert.equal(result.customers.find(item => item.customerId === 'c').scoreBreakdown.evidence, 30);
  assert.equal(result.customers.find(item => item.customerId === 'c').evidenceQualificationThreshold, 6);
  assert.equal(result.customers.find(item => item.customerId === 'c').momentsOrdersQualified, true);
  assert.equal(result.customers.some(item => item.customerId === 'pending'), false);
  assert.equal(result.customers.some(item => item.customerId === 'deleted'), false);
  assert.equal(result.customers.some(item => item.customerId === 'paid'), false);
  assert.equal(result.customers.filter(item => item.customerId === 'dup').length, 1);

  const custom = computeCustomerPriority({ id: 'custom', name: '自定义', douyin_followers: '4999', sales_status: '自定义状态' }, 5, [
    { name: '自定义状态', priority_enabled: 1, priority_score: 12, priority_excluded: 0 }
  ]);
  assert.equal(custom.score, 12, '未达到朋友圈客单阈值时不应再获得部分分');
  assert.equal(custom.scoreBreakdown.evidence, 0);

  const exactlyQualified = computeCustomerPriority({
    id: 'exactly-qualified', name: '刚好达标', sales_status: '新客户'
  }, 6);
  assert.equal(exactlyQualified.momentsOrdersQualified, true);
  assert.equal(exactlyQualified.scoreBreakdown.evidence, 30);

  const qualifiedByStoredCount = computeCustomerPriority({
    id: 'stored-count', name: '截图和历史客单', moments_orders: 5, sales_status: '新客户'
  }, 6);
  assert.equal(qualifiedByStoredCount.evidenceCount, 6);
  assert.equal(qualifiedByStoredCount.evidenceTotal, 11);
  assert.equal(qualifiedByStoredCount.momentsOrdersQualified, true);
  assert.equal(qualifiedByStoredCount.scoreBreakdown.evidence, 30);

  const explicitNo = computeCustomerPriority({
    id: 'explicit-no', name: '明确否', moments_orders: 99, moments_orders_qualified: false, sales_status: '新客户'
  }, 99);
  assert.equal(explicitNo.momentsOrdersQualified, false);
  assert.equal(explicitNo.scoreBreakdown.evidence, 0, '明确选择“否”时数量再多也不得分');

  const explicitYes = computeCustomerPriority({
    id: 'explicit-yes', name: '明确是', moments_orders_qualified: true, sales_status: '新客户'
  }, 0);
  assert.equal(explicitYes.momentsOrdersQualified, true);
  assert.equal(explicitYes.scoreBreakdown.evidence, 30, '明确选择“是”时应按唯一达标规则得分');

  const unselected = computeCustomerPriority({
    id: 'unselected', name: '未选择', moments_orders: 99, moments_orders_qualified: null, sales_status: '新客户'
  }, 99);
  assert.equal(unselected.momentsOrdersQualified, null);
  assert.equal(unselected.scoreBreakdown.evidence, 0, '是/否均未选择时不应评分');

  const legacyConfig = {
    weights: { followers: 40, evidence: 30, status: 30 },
    thresholds: { first: 80, second: 60, third: 40 },
    followers: [{ min: 10000, score: 40 }, { min: 5000, score: 20 }],
    evidence: [{ min: 6, score: 30 }, { min: 1, score: 10 }]
  };
  const savedConfig = savePriorityConfig(db, teamId, legacyConfig);
  assert.deepEqual(savedConfig.evidence, [{ min: 6, score: 30 }], '旧的多级客单规则应归一为一个达标规则');
  assert.deepEqual(getPriorityConfig(db, teamId).evidence, [{ min: 6, score: 30 }]);

  const migrationDbPath = path.join(tempDir, 'migration.db');
  process.env.ZHIXUN_DB_PATH = migrationDbPath;
  const database = require('../src/config/database');
  database.initDatabase();
  const migrated = database.getDatabase();
  migrated.prepare(`INSERT INTO users (id, username, password_hash, display_name) VALUES (?, ?, ?, ?)`).run(1, 'test-user', 'hash', '测试用户');
  migrated.prepare(`INSERT INTO customers (id, user_id, name, sales_status) VALUES (?, ?, ?, ?)`).run(987654321, 1, '保留客户', '新客户');
  database.closeDatabase();
  database.initDatabase();
  const migratedAgain = database.getDatabase();
  assert.equal(migratedAgain.prepare('SELECT COUNT(*) count FROM customers WHERE id = ?').get(987654321).count, 1);
  assert.equal(migratedAgain.prepare("SELECT COUNT(*) count FROM pragma_table_info('customer_evidence') WHERE name = 'customer_id'").get().count, 1);
  assert.equal(migratedAgain.prepare("SELECT COUNT(*) count FROM pragma_table_info('sales_statuses') WHERE name = 'priority_score'").get().count, 1);
  assert.equal(migratedAgain.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  database.closeDatabase();
  console.log('priority customer tests passed');
} finally {
  try { db.close(); } catch (_) {}
  fs.rmSync(tempDir, { recursive: true, force: true });
}
