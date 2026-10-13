const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { normalizeWorkspaceState } = require('../services/workspaceState');

const DATA_DIR = path.resolve(process.env.ZHIXUN_DATA_DIR || path.join(__dirname, '..', '..', 'data'));
const DB_PATH = path.resolve(process.env.ZHIXUN_DB_PATH || path.join(DATA_DIR, 'zhixun.db'));

let db;


const DEFAULT_TEAM_CODE = 'operations-default';
const DEFAULT_TEAM_NAME = '运营团队';

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[DB] 迁移: 已添加 ${table}.${column}`);
  }
}

function ensureColumns(db, table, columns) {
  for (const [column, definition] of Object.entries(columns)) {
    ensureColumn(db, table, column, definition);
  }
}

function ensureTeamSharingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code VARCHAR(80) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      status VARCHAR(20) DEFAULT 'active',
      created_by_user_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      role VARCHAR(20) DEFAULT 'member',
      status VARCHAR(20) DEFAULT 'active',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL UNIQUE REFERENCES teams(id),
      state_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 0,
      initialized_by_user_id INTEGER REFERENCES users(id),
      updated_by_user_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id VARCHAR(80) UNIQUE NOT NULL,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      entity_type VARCHAR(50) NOT NULL,
      entity_id VARCHAR(120),
      action VARCHAR(50) NOT NULL,
      entity_version INTEGER DEFAULT 0,
      operator_user_id INTEGER REFERENCES users(id),
      request_id VARCHAR(100),
      payload TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      operator_user_id INTEGER REFERENCES users(id),
      entity_type VARCHAR(50) NOT NULL,
      entity_id VARCHAR(120),
      action VARCHAR(50) NOT NULL,
      before_data TEXT,
      after_data TEXT,
      request_id VARCHAR(100),
      ip_address VARCHAR(80),
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS idempotency_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      request_id VARCHAR(100) NOT NULL,
      response_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team_id, request_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_customer_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      customer_id VARCHAR(120) NOT NULL,
      user_id INTEGER REFERENCES users(id),
      operator_user_id INTEGER REFERENCES users(id),
      from_status VARCHAR(50),
      to_status VARCHAR(50),
      reason TEXT,
      source VARCHAR(30) DEFAULT 'web',
      request_id VARCHAR(100),
      sync_event_id VARCHAR(80),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team_id, request_id, customer_id, from_status, to_status)
    );

    CREATE TABLE IF NOT EXISTS workspace_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      import_id VARCHAR(120) NOT NULL,
      batch_index INTEGER NOT NULL,
      total_batches INTEGER NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      skipped_ids TEXT DEFAULT '[]',
      skip_reasons TEXT DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 0,
      request_id VARCHAR(100),
      created_by_user_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team_id, import_id, batch_index)
    );

    CREATE TABLE IF NOT EXISTS scraper_pending_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      created_by_user_id INTEGER NOT NULL REFERENCES users(id),
      session_id VARCHAR(120) NOT NULL,
      payload_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_queue_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id VARCHAR(160) NOT NULL,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      operation VARCHAR(40) NOT NULL,
      total_batches INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 40,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at DATETIME,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      UNIQUE(team_id, queue_id)
    );

    CREATE TABLE IF NOT EXISTS sync_queue_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES sync_queue_jobs(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL,
      total_batches INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at DATETIME,
      last_error TEXT,
      response_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      UNIQUE(job_id, batch_index)
    );

    CREATE TABLE IF NOT EXISTS knowledge_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      source_type VARCHAR(30) NOT NULL,
      source_id VARCHAR(120) NOT NULL,
      target_type VARCHAR(30) NOT NULL,
      target_id VARCHAR(120) NOT NULL,
      relation_type VARCHAR(30) DEFAULT 'reference',
      created_by_user_id INTEGER REFERENCES users(id),
      updated_by_user_id INTEGER REFERENCES users(id),
      version INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME,
      deleted_by_user_id INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS customer_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      customer_id VARCHAR(120) NOT NULL,
      evidence_type VARCHAR(50) NOT NULL DEFAULT 'moments_order_screenshot',
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      file_path TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      created_by_user_id INTEGER REFERENCES users(id),
      updated_by_user_id INTEGER REFERENCES users(id),
      version INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME,
      deleted_by_user_id INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS customer_data_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      customer_id VARCHAR(120) NOT NULL,
      owner_user_id INTEGER REFERENCES users(id),
      requester_user_id INTEGER NOT NULL REFERENCES users(id),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      request_reason TEXT,
      decision_note TEXT,
      decided_by_user_id INTEGER REFERENCES users(id),
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      decided_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team_id, customer_id, requester_user_id)
    );

  `);

  // 兼容曾经初始化过但字段不完整的同步表。必须先补列，再创建依赖这些列的索引。
  // 新增列保持可空或提供默认值，避免已有记录导致 SQLite ALTER TABLE 失败。
  ensureColumns(db, 'teams', {
    code: 'VARCHAR(80)',
    name: 'VARCHAR(100)',
    status: "VARCHAR(20) DEFAULT 'active'",
    priority_config: 'TEXT',
    created_by_user_id: 'INTEGER REFERENCES users(id)',
    created_at: 'DATETIME',
    updated_at: 'DATETIME'
  });
  ensureColumns(db, 'team_members', {
    team_id: 'INTEGER REFERENCES teams(id)',
    user_id: 'INTEGER REFERENCES users(id)',
    role: "VARCHAR(20) DEFAULT 'member'",
    status: "VARCHAR(20) DEFAULT 'active'",
    joined_at: 'DATETIME',
    created_at: 'DATETIME'
  });
  ensureColumns(db, 'workspace_states', {
    team_id: 'INTEGER REFERENCES teams(id)',
    state_json: "TEXT DEFAULT '{}'",
    version: 'INTEGER DEFAULT 0',
    initialized_by_user_id: 'INTEGER REFERENCES users(id)',
    updated_by_user_id: 'INTEGER REFERENCES users(id)',
    created_at: 'DATETIME',
    updated_at: 'DATETIME'
  });
  ensureColumns(db, 'sync_events', {
    event_id: 'VARCHAR(80)',
    team_id: 'INTEGER REFERENCES teams(id)',
    entity_type: 'VARCHAR(50)',
    entity_id: 'VARCHAR(120)',
    action: 'VARCHAR(50)',
    entity_version: 'INTEGER DEFAULT 0',
    operator_user_id: 'INTEGER REFERENCES users(id)',
    request_id: 'VARCHAR(100)',
    payload: "TEXT DEFAULT '{}'",
    created_at: 'DATETIME'
  });
  ensureColumns(db, 'operation_logs', {
    team_id: 'INTEGER REFERENCES teams(id)',
    operator_user_id: 'INTEGER REFERENCES users(id)',
    entity_type: 'VARCHAR(50)',
    entity_id: 'VARCHAR(120)',
    action: 'VARCHAR(50)',
    before_data: 'TEXT',
    after_data: 'TEXT',
    request_id: 'VARCHAR(100)',
    ip_address: 'VARCHAR(80)',
    user_agent: 'TEXT',
    created_at: 'DATETIME'
  });
  ensureColumns(db, 'idempotency_requests', {
    team_id: 'INTEGER REFERENCES teams(id)',
    user_id: 'INTEGER REFERENCES users(id)',
    request_id: 'VARCHAR(100)',
    response_json: 'TEXT',
    created_at: 'DATETIME'
  });
  ensureColumns(db, 'workspace_customer_status_history', {
    team_id: 'INTEGER REFERENCES teams(id)',
    customer_id: 'VARCHAR(120)',
    user_id: 'INTEGER REFERENCES users(id)',
    operator_user_id: 'INTEGER REFERENCES users(id)',
    from_status: 'VARCHAR(50)',
    to_status: 'VARCHAR(50)',
    reason: 'TEXT',
    source: "VARCHAR(30) DEFAULT 'web'",
    request_id: 'VARCHAR(100)',
    sync_event_id: 'VARCHAR(80)',
    created_at: 'DATETIME'
  });
  ensureColumns(db, 'workspace_import_batches', {
    team_id: 'INTEGER REFERENCES teams(id)',
    import_id: 'VARCHAR(120)',
    batch_index: 'INTEGER',
    total_batches: 'INTEGER',
    row_count: 'INTEGER NOT NULL DEFAULT 0',
    skipped_count: 'INTEGER NOT NULL DEFAULT 0',
    skipped_ids: "TEXT DEFAULT '[]'",
    skip_reasons: "TEXT DEFAULT '{}'",
    version: 'INTEGER NOT NULL DEFAULT 0',
    request_id: 'VARCHAR(100)',
    created_by_user_id: 'INTEGER REFERENCES users(id)',
    created_at: 'DATETIME'
  });
  ensureColumns(db, 'sync_queue_jobs', {
    queue_id: 'VARCHAR(160)',
    team_id: 'INTEGER REFERENCES teams(id)',
    user_id: 'INTEGER REFERENCES users(id)',
    operation: 'VARCHAR(40)',
    total_batches: 'INTEGER NOT NULL DEFAULT 0',
    priority: 'INTEGER NOT NULL DEFAULT 40',
    status: "VARCHAR(20) NOT NULL DEFAULT 'pending'",
    attempts: 'INTEGER NOT NULL DEFAULT 0',
    next_attempt_at: 'DATETIME',
    last_error: 'TEXT',
    created_at: 'DATETIME',
    updated_at: 'DATETIME',
    completed_at: 'DATETIME'
  });
  ensureColumns(db, 'sync_queue_batches', {
    job_id: 'INTEGER REFERENCES sync_queue_jobs(id)',
    batch_index: 'INTEGER',
    total_batches: 'INTEGER',
    payload_json: "TEXT DEFAULT '{}'",
    status: "VARCHAR(20) NOT NULL DEFAULT 'pending'",
    attempts: 'INTEGER NOT NULL DEFAULT 0',
    next_attempt_at: 'DATETIME',
    last_error: 'TEXT',
    response_json: 'TEXT',
    created_at: 'DATETIME',
    updated_at: 'DATETIME',
    completed_at: 'DATETIME'
  });
  // Jobs created before priority scheduling was introduced are ordinary patch
  // syncs, so promote them when the schema is opened for the first time.
  db.prepare("UPDATE sync_queue_jobs SET priority = 100 WHERE operation = 'patch' AND COALESCE(priority, 40) = 40").run();

  ensureColumns(db, 'knowledge_relations', {
    team_id: 'INTEGER REFERENCES teams(id)',
    source_type: 'VARCHAR(30)',
    source_id: 'VARCHAR(120)',
    target_type: 'VARCHAR(30)',
    target_id: 'VARCHAR(120)',
    relation_type: "VARCHAR(30) DEFAULT 'reference'",
    created_by_user_id: 'INTEGER REFERENCES users(id)',
    updated_by_user_id: 'INTEGER REFERENCES users(id)',
    version: 'INTEGER DEFAULT 1',
    created_at: 'DATETIME',
    updated_at: 'DATETIME',
    deleted_at: 'DATETIME',
    deleted_by_user_id: 'INTEGER REFERENCES users(id)'
  });

  ensureColumns(db, 'customer_evidence', {
    team_id: 'INTEGER REFERENCES teams(id)',
    customer_id: 'VARCHAR(120)',
    evidence_type: "VARCHAR(50) DEFAULT 'moments_order_screenshot'",
    file_name: 'VARCHAR(255)',
    mime_type: 'VARCHAR(100)',
    file_path: 'TEXT',
    byte_size: 'INTEGER DEFAULT 0',
    created_by_user_id: 'INTEGER REFERENCES users(id)',
    updated_by_user_id: 'INTEGER REFERENCES users(id)',
    version: 'INTEGER DEFAULT 1',
    created_at: 'DATETIME',
    updated_at: 'DATETIME',
    deleted_at: 'DATETIME',
    deleted_by_user_id: 'INTEGER REFERENCES users(id)'
  });
  ensureColumns(db, 'customer_data_permissions', {
    team_id: 'INTEGER REFERENCES teams(id)',
    customer_id: 'VARCHAR(120)',
    owner_user_id: 'INTEGER REFERENCES users(id)',
    requester_user_id: 'INTEGER REFERENCES users(id)',
    status: "VARCHAR(20) DEFAULT 'pending'",
    request_reason: 'TEXT',
    decision_note: 'TEXT',
    decided_by_user_id: 'INTEGER REFERENCES users(id)',
    requested_at: 'DATETIME',
    decided_at: 'DATETIME',
    created_at: 'DATETIME',
    updated_at: 'DATETIME'
  });
  ensureColumns(db, 'sales_statuses', {
    priority_enabled: 'INTEGER NOT NULL DEFAULT 1',
    priority_score: 'INTEGER NOT NULL DEFAULT 10',
    priority_excluded: 'INTEGER NOT NULL DEFAULT 0'
  });

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_sync_events_team_cursor ON sync_events(team_id, id);
    CREATE INDEX IF NOT EXISTS idx_sync_events_team_request ON sync_events(team_id, request_id);
    CREATE INDEX IF NOT EXISTS idx_operation_logs_team_created ON operation_logs(team_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_status_history_team_customer ON workspace_customer_status_history(team_id, customer_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_status_history_team_request ON workspace_customer_status_history(team_id, request_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_import_batches_lookup ON workspace_import_batches(team_id, import_id, batch_index);
    DROP INDEX IF EXISTS idx_sync_queue_jobs_ready;
    CREATE INDEX IF NOT EXISTS idx_sync_queue_jobs_ready ON sync_queue_jobs(status, next_attempt_at, priority, id);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_jobs_team ON sync_queue_jobs(team_id, queue_id);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_batches_ready ON sync_queue_batches(job_id, status, batch_index);
    CREATE INDEX IF NOT EXISTS idx_knowledge_relations_source ON knowledge_relations(team_id, source_type, source_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_relations_target ON knowledge_relations(team_id, target_type, target_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_customer_evidence_team_customer ON customer_evidence(team_id, customer_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_customer_evidence_active ON customer_evidence(team_id, evidence_type, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_customer_data_permissions_owner ON customer_data_permissions(team_id, owner_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_customer_data_permissions_requester ON customer_data_permissions(team_id, requester_user_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_relations_unique
      ON knowledge_relations(team_id, source_type, source_id, target_type, target_id, relation_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_status_history_request_event
      ON workspace_customer_status_history(
        team_id,
        request_id,
        customer_id,
        COALESCE(from_status, ''),
        COALESCE(to_status, '')
      )
      WHERE request_id IS NOT NULL;
  `);

  const creator = db.prepare("SELECT id FROM users ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END, id LIMIT 1").get();
  db.prepare(`INSERT OR IGNORE INTO teams (code, name, status, created_by_user_id) VALUES (?, ?, 'active', ?)`)
    .run(DEFAULT_TEAM_CODE, DEFAULT_TEAM_NAME, creator ? creator.id : null);
  const team = db.prepare('SELECT id FROM teams WHERE code = ?').get(DEFAULT_TEAM_CODE);
  if (!team) throw new Error('固定运营团队初始化失败');
  // 兼容早期试运行版本使用的“启用/正常”状态值，统一为当前权限中间件识别的 active。
  db.prepare(`UPDATE teams SET name = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(DEFAULT_TEAM_NAME, team.id);

  db.prepare(`INSERT OR IGNORE INTO team_members (team_id, user_id, role, status)
    SELECT ?, id, CASE WHEN role='admin' THEN 'admin' ELSE 'member' END, 'active' FROM users`).run(team.id);
  db.prepare(`UPDATE team_members SET status = 'active'
    WHERE team_id = ? AND (status IS NULL OR status IN ('正常', '启用'))`).run(team.id);

  const businessTables = [
    'customers', 'tasks', 'experiences', 'feedback', 'chat_records', 'sales_statuses',
    'customer_status_history', 'tags', 'materials_files', 'materials_jobs', 'product_requests'
  ];
  for (const table of businessTables) {
    ensureColumn(db, table, 'team_id', 'INTEGER REFERENCES teams(id)');
    ensureColumn(db, table, 'created_by_user_id', 'INTEGER REFERENCES users(id)');
    ensureColumn(db, table, 'updated_by_user_id', 'INTEGER REFERENCES users(id)');
    ensureColumn(db, table, 'version', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn(db, table, 'deleted_at', 'DATETIME');
    ensureColumn(db, table, 'deleted_by_user_id', 'INTEGER REFERENCES users(id)');
    db.prepare(`UPDATE ${table} SET team_id = COALESCE(team_id, ?), created_by_user_id = COALESCE(created_by_user_id, user_id), updated_by_user_id = COALESCE(updated_by_user_id, user_id), version = COALESCE(version, 1)`).run(team.id);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_team ON ${table}(team_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_team_active ON ${table}(team_id, deleted_at)`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_team_on_insert
      AFTER INSERT ON ${table}
      WHEN NEW.team_id IS NULL
      BEGIN
        UPDATE ${table}
        SET team_id = (SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE tm.user_id=NEW.user_id AND tm.status='active' AND t.code='operations-default' LIMIT 1),
            created_by_user_id = COALESCE(NEW.created_by_user_id, NEW.user_id),
            updated_by_user_id = COALESCE(NEW.updated_by_user_id, NEW.user_id),
            version = COALESCE(NEW.version, 1)
        WHERE id=NEW.id;
      END;
    `);
  }
  ensureColumn(db, 'customer_status_history', 'operator_user_id', 'INTEGER REFERENCES users(id)');
  ensureColumn(db, 'customer_status_history', 'source', "VARCHAR(30) DEFAULT 'web'");
  ensureColumn(db, 'customer_status_history', 'request_id', 'VARCHAR(100)');
  ensureColumn(db, 'customer_status_history', 'sync_event_id', 'VARCHAR(80)');
  db.prepare('UPDATE customer_status_history SET operator_user_id = COALESCE(operator_user_id, user_id)').run();

  db.prepare(`INSERT OR IGNORE INTO workspace_states (team_id, state_json, version) VALUES (?, '{}', 0)`).run(team.id);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_users_join_default_team
    AFTER INSERT ON users
    BEGIN
      INSERT OR IGNORE INTO team_members (team_id, user_id, role, status)
      SELECT id, NEW.id, CASE WHEN NEW.role='admin' THEN 'admin' ELSE 'member' END, 'active'
      FROM teams WHERE code='operations-default';
    END;
  `);

  return team.id;
}

function getDatabase() {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 10000');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDatabase() {
  const db = getDatabase();

  db.exec(`
    -- 用户表
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      phone VARCHAR(20),
      display_name VARCHAR(100),
      role VARCHAR(20) DEFAULT 'user',
      avatar_url TEXT,
      password_hint VARCHAR(100),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 密码重置申请记录
    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_user_id INTEGER NOT NULL REFERENCES users(id),
      requested_by_user_id INTEGER REFERENCES users(id),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      processed_by_user_id INTEGER REFERENCES users(id),
      requested_ip VARCHAR(100),
      processed_ip VARCHAR(100)
    );

    -- 客户表
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      wechat_id VARCHAR(50),
      qq VARCHAR(100),
      wechat_nickname VARCHAR(100),
      douyin_nickname VARCHAR(100),
      douyin_id VARCHAR(100),
      douyin_followers INTEGER DEFAULT 0,
      channel_account VARCHAR(100),
      official_account VARCHAR(100),
      address VARCHAR(255),
      video_account VARCHAR(100),
      public_account VARCHAR(100),
      sales_status VARCHAR(50) DEFAULT '新客户',
      approval_status VARCHAR(20) DEFAULT '正式',
      province VARCHAR(50),
      city VARCHAR(50),
      org_name VARCHAR(200),
      identity VARCHAR(50),
      source VARCHAR(50),
      level VARCHAR(20) DEFAULT '潜在客户',
      status VARCHAR(20) DEFAULT '新线索',
      tags TEXT DEFAULT '[]',
      notes TEXT,
      extra_data TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 任务表
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      customer_id INTEGER REFERENCES customers(id),
      feedback_id INTEGER REFERENCES feedback(id),
      title VARCHAR(200) NOT NULL,
      description TEXT,
      task_type VARCHAR(50),
      status VARCHAR(20) DEFAULT '待办',
      priority VARCHAR(20) DEFAULT '普通',
      due_date DATE,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 经验库表
    CREATE TABLE IF NOT EXISTS experiences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title VARCHAR(200) NOT NULL,
      content TEXT,
      category VARCHAR(50),
      tags TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 反馈表
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      customer_id INTEGER REFERENCES customers(id),
      customer_name VARCHAR(100),
      province VARCHAR(50),
      tags TEXT DEFAULT '[]',
      issue_type VARCHAR(100),
      content TEXT,
      priority VARCHAR(20) DEFAULT '普通',
      assignee VARCHAR(100),
      due_date DATE,
      resolved_at DATETIME,
      status VARCHAR(20) DEFAULT '待处理',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 微信聊天记录表
    CREATE TABLE IF NOT EXISTS chat_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      customer_id INTEGER REFERENCES customers(id),
      file_name VARCHAR(255),
      messages TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 销售状态配置表
    CREATE TABLE IF NOT EXISTS sales_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name VARCHAR(50) NOT NULL,
      color VARCHAR(20) DEFAULT '#315efb',
      sort_order INTEGER DEFAULT 0,
      is_funnel INTEGER DEFAULT 0,
      is_enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    );

    -- 客户状态变更记录
    CREATE TABLE IF NOT EXISTS customer_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      from_status VARCHAR(50),
      to_status VARCHAR(50),
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 标签表
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name VARCHAR(50) NOT NULL,
      color VARCHAR(20),
      category VARCHAR(50),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 资料库文件表：文件原格式长期保留，转换和执行均通过任务记录处理
    CREATE TABLE IF NOT EXISTS materials_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(150),
      extension VARCHAR(20),
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      status VARCHAR(30) DEFAULT 'stored',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS materials_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      material_id INTEGER NOT NULL REFERENCES materials_files(id),
      job_type VARCHAR(30) NOT NULL,
      target_format VARCHAR(20),
      status VARCHAR(30) DEFAULT 'queued',
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 产品需求表
    CREATE TABLE IF NOT EXISTS product_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title VARCHAR(200) NOT NULL,
      description TEXT,
      priority VARCHAR(20) DEFAULT '普通',
      status VARCHAR(20) DEFAULT '规划中',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 兼容已经存在的旧数据库：为用户表补充手机号字段。
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some((column) => column.name === 'phone')) {
    db.exec('ALTER TABLE users ADD COLUMN phone VARCHAR(20)');
    // 使用唯一索引代替列级 UNIQUE 约束（兼容旧版 SQLite）
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)');
    console.log('[DB] 迁移: 已添加 phone 字段到 users 表');
  }
  if (!userColumns.some((column) => column.name === 'password_hint')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hint VARCHAR(100)');
    console.log('[DB] 迁移: 已添加 password_hint 字段到 users 表');
  }

  // 一站式客户工作台字段迁移：旧列保留用于历史数据兼容。
  ensureColumn(db, 'customers', 'douyin_id', 'VARCHAR(100)');
  ensureColumn(db, 'customers', 'douyin_followers', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'customers', 'channel_account', 'VARCHAR(100)');
  ensureColumn(db, 'customers', 'official_account', 'VARCHAR(100)');
  ensureColumn(db, 'customers', 'address', 'VARCHAR(255)');
  ensureColumn(db, 'customers', 'qq', 'VARCHAR(100)');
  ensureColumn(db, 'customers', 'video_account', 'VARCHAR(100)');
  ensureColumn(db, 'customers', 'public_account', 'VARCHAR(100)');
  ensureColumn(db, 'customers', 'sales_status', "VARCHAR(50) DEFAULT '新客户'");
  ensureColumn(db, 'customers', 'approval_status', "VARCHAR(20) DEFAULT '正式'");
  ensureColumn(db, 'tasks', 'feedback_id', 'INTEGER');
  ensureColumn(db, 'feedback', 'priority', "VARCHAR(20) DEFAULT '普通'");
  ensureColumn(db, 'feedback', 'assignee', 'VARCHAR(100)');
  ensureColumn(db, 'feedback', 'due_date', 'DATE');
  ensureColumn(db, 'feedback', 'resolved_at', 'DATETIME');
  ensureColumn(db, 'materials_files', 'category', "VARCHAR(50) DEFAULT '资料文件'");

  // 兼容两套视频号、公众号字段命名，统一保留数据。
  db.exec(`UPDATE customers SET
    channel_account = COALESCE(NULLIF(channel_account, ''), video_account, ''),
    official_account = COALESCE(NULLIF(official_account, ''), public_account, ''),
    video_account = COALESCE(NULLIF(video_account, ''), channel_account, ''),
    public_account = COALESCE(NULLIF(public_account, ''), official_account, '')`);

  // 将旧状态映射到新版销售状态，不删除任何历史字段。
  const oldPendingStatus = '\u5f85\u8ddf\u8fdb';
  db.prepare(`UPDATE customers SET sales_status = CASE
    WHEN status IS NULL OR status = '' OR status = '新线索' OR status = ? THEN '新客户'
    WHEN status = '已跟进' THEN '已联系'
    WHEN status = '已成交' THEN '已付费'
    WHEN status = '已关闭' THEN '已流失'
    ELSE status END
    WHERE sales_status IS NULL OR sales_status = ''`).run(oldPendingStatus);
  db.prepare(`UPDATE customers SET sales_status = CASE
    WHEN sales_status = ? THEN '新客户'
    WHEN sales_status = '已跟进' THEN '已联系'
    WHEN sales_status = '已成交' THEN '已付费'
    WHEN sales_status = '已关闭' THEN '已流失'
    ELSE sales_status END`).run(oldPendingStatus);

  // 兼容旧 extra_data 中保存的抖音号。
  const legacyDouyinRows = db.prepare("SELECT id, extra_data FROM customers WHERE (douyin_id IS NULL OR douyin_id = '') AND extra_data LIKE '%douyin_link%'").all();
  for (const row of legacyDouyinRows) {
    try {
      const extra = JSON.parse(row.extra_data || '{}');
      if (extra.douyin_link) db.prepare('UPDATE customers SET douyin_id = ? WHERE id = ?').run(String(extra.douyin_link), row.id);
    } catch (e) { console.error('[DB] Failed to parse extra_data for row', row.id, e.message); }
  }

  ensureColumn(db, 'users', 'status', "VARCHAR(20) DEFAULT 'active'");
  db.prepare("UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''").run();

  ensureColumn(db, 'users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'password_reset_required', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS password_reset_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_user_id INTEGER NOT NULL REFERENCES users(id),
    requested_by_user_id INTEGER REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    processed_by_user_id INTEGER REFERENCES users(id),
    requested_ip VARCHAR(100),
    processed_ip VARCHAR(100)
  );`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_pending
    ON password_reset_requests(target_user_id) WHERE status = 'pending'`);

  ensureTeamSharingSchema(db);
  migrateWorkspaceStatePayloads(db);
  pruneSyncIdempotencyCache(db);

  console.log('[DB] 数据库初始化完成');
}

function migrateWorkspaceStatePayloads(db) {
  const rows = db.prepare(`SELECT team_id, state_json, initialized_by_user_id, updated_by_user_id
    FROM workspace_states WHERE state_json IS NOT NULL`).all();
  const update = db.prepare(`UPDATE workspace_states
    SET state_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE team_id = ?`);
  let migrated = 0;
  const migrate = db.transaction(() => {
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(row.state_json || '{}'); } catch (_) { continue; }
      const ownerId = row.updated_by_user_id || row.initialized_by_user_id || null;
      const owner = ownerId ? db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(ownerId) : null;
      const normalized = normalizeWorkspaceState(parsed, {
        defaultCaptureOwnerId: ownerId,
        defaultCaptureOwnerName: owner?.display_name || owner?.username || '',
        defaultTaskOwnerId: ownerId,
        defaultTaskOwnerName: owner?.display_name || owner?.username || ''
      });
      const serialized = JSON.stringify(normalized);
      if (serialized === row.state_json) continue;
      update.run(serialized, row.team_id);
      migrated += 1;
    }
  });
  migrate();
  if (migrated) console.log(`[DB] 迁移: 已压缩 ${migrated} 条团队同步状态`);
}

function pruneSyncIdempotencyCache(db) {
  // Idempotency rows are retry metadata only. Older versions stored a full
  // workspace snapshot in every row, which made the SQLite file grow without
  // bound. Clear the legacy retry cache; business data and audit logs remain
  // untouched.
  const result = db.prepare('DELETE FROM idempotency_requests').run();
  if (result.changes) console.log(`[DB] 迁移: 已清理 ${result.changes} 条旧版同步重试缓存`);
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDatabase, initDatabase, closeDatabase, ensureTeamSharingSchema, DEFAULT_TEAM_CODE, DB_PATH };
