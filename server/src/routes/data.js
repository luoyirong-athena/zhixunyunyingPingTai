const express = require("express");
const { getDatabase } = require("../config/database");
const { authRequired, adminRequired } = require("../middleware/auth");
const {
  resolveTeamContext,
  enforceTeamWriteByMethod,
} = require("../middleware/team");
const {
  requestId,
  recordChange,
  publishEvents,
} = require("../services/teamEvents");
const {
  CONFIRMATION_TEXT,
  resetBusinessData,
} = require("../services/businessDataReset");
const { canWriteCustomer } = require("../services/dataPermissions");
const { workspaceCollections } = require("../services/workspaceReadModel");
const { reconcileLegacyTables } = require("../services/workspaceLegacyBridge");
const router = express.Router();
router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);
const TABLES = [
  "customers",
  "tasks",
  "feedback",
  "experiences",
  "tags",
  "product_requests",
  "chat_records",
  "sales_statuses",
  "customer_status_history",
];
const normalizeProvince = (value) =>
  String(value || "")
    .trim()
    .replace(
      /(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/,
      "",
    );
const jsonText = (value, fallback) =>
  JSON.stringify(value && typeof value === "object" ? value : fallback);
const oldPendingStatus = "\u5f85\u8ddf\u8fdb";
function normalizedSalesStatus(value) {
  const status = String(value || "").trim();
  if (!status || status === oldPendingStatus || status === "新线索")
    return "新客户";
  if (status === "已跟进") return "已联系";
  if (status === "已成交") return "已付费";
  if (status === "已关闭") return "已流失";
  return status;
}
function importText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
function importContact(value) {
  return importText(value).toLowerCase();
}
function importValue(value) {
  return (
    value !== undefined &&
    value !== null &&
    (!Array.isArray(value) && typeof value !== "object"
      ? importText(value) !== ""
      : Object.keys(value).length > 0)
  );
}
function importCustomerFields(c) {
  const channel = importText(
      c.channel_account || c.video_account || c.videoAccount,
    ),
    official = importText(
      c.official_account || c.public_account || c.publicAccount,
    );
  const rawSalesStatus = c.sales_status ?? c.salesStatus ?? c.status;
  const fields = {
    name: importText(c.name || c.customer_name),
    province: normalizeProvince(c.province),
    city: importText(c.city),
    sales_status: importValue(rawSalesStatus)
      ? normalizedSalesStatus(rawSalesStatus)
      : "",
    phone: importText(c.phone),
    identity: importText(c.identity),
    qq: importText(c.qq ?? c.qq_number ?? c.qqNumber),
    org_name: importText(c.org_name || c.orgName),
    wechat_nickname: importText(c.wechat_nickname || c.wechatNickname),
    wechat_id: importText(c.wechat_id || c.wechatId),
    douyin_nickname: importText(c.douyin_nickname || c.douyinNickname),
    douyin_id: importText(c.douyin_id || c.douyinId),
    channel_account: channel,
    official_account: official,
    address: importText(c.address || c.customer_address),
    video_account: channel,
    public_account: official,
    notes: importText(c.notes || c.remark),
    source: importText(c.source),
    level: importText(c.level),
    tags: c.tags,
    extra_data: c.extra_data || c.extraData,
    douyin_followers: c.douyin_followers ?? c.douyinFollowers,
  };
  return fields;
}
function findImportedCustomer(db, teamId, c) {
  const byId =
    c && c.id !== undefined && c.id !== null
      ? db
          .prepare(
            "SELECT * FROM customers WHERE id=? AND team_id=? AND deleted_at IS NULL",
          )
          .get(c.id, teamId)
      : null;
  if (byId) return byId;
  for (const [field, value] of [
    ["phone", c.phone],
    ["wechat_id", c.wechat_id || c.wechatId],
    ["douyin_id", c.douyin_id || c.douyinId],
  ]) {
    const normalized = importContact(value);
    if (!normalized) continue;
    const row = db
      .prepare(
        `SELECT * FROM customers WHERE team_id=? AND deleted_at IS NULL AND lower(trim(COALESCE(${field},'')))=? ORDER BY id LIMIT 1`,
      )
      .get(teamId, normalized);
    if (row) return row;
  }
  return null;
}
function updateImportedCustomer(db, customer, fields, userId) {
  const columnValues = [];
  const allowed = [
    "name",
    "province",
    "city",
    "sales_status",
    "phone",
    "identity",
    "qq",
    "org_name",
    "wechat_nickname",
    "wechat_id",
    "douyin_nickname",
    "douyin_id",
    "channel_account",
    "official_account",
    "address",
    "video_account",
    "public_account",
    "notes",
    "source",
    "level",
    "douyin_followers",
  ];
  for (const column of allowed) {
    if (!importValue(fields[column])) continue;
    columnValues.push([column, fields[column]]);
  }
  if (importValue(fields.tags))
    columnValues.push(["tags", jsonText(fields.tags, [])]);
  if (importValue(fields.extra_data))
    columnValues.push(["extra_data", jsonText(fields.extra_data, {})]);
  if (!columnValues.length) return false;
  const assignments = columnValues.map(([column]) => `${column}=?`).join(", ");
  db.prepare(
    `UPDATE customers SET ${assignments}, updated_by_user_id=?, version=COALESCE(version,0)+1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND team_id=?`,
  ).run(
    ...columnValues.map(([, value]) => value),
    userId,
    customer.id,
    customer.team_id,
  );
  return true;
}
router.get("/export", (req, res) => {
  const db = getDatabase();
  const requested = req.query.tables
    ? req.query.tables.split(",").filter((name) => TABLES.includes(name))
    : TABLES;
  const result = {
    version: 3,
    team: { id: req.team.id, code: req.team.code, name: req.team.name },
    exported_at: new Date().toISOString(),
  };
  const workspace = workspaceExportCollections(req);
  for (const table of requested) {
    try {
      const values = workspace[table];
      if (
        Array.isArray(values) &&
        (values.length ||
          [
            "customers",
            "tasks",
            "feedback",
            "experiences",
            "chat_records",
            "sales_statuses",
          ].includes(table))
      ) {
        const legacy = db
          .prepare(`SELECT * FROM ${table} WHERE team_id=? AND deleted_at IS NULL`)
          .all(req.team.id)
          .map((row) => {
            const copy = { ...row };
            for (const key of ["tags", "extra_data", "messages"])
              if (typeof copy[key] === "string")
                try {
                  copy[key] = JSON.parse(copy[key]);
                } catch {}
            return copy;
          });
        const known = new Set(
          values.map((row) => String(row?.id ?? row?.name ?? "")),
        );
        result[table] = values.concat(
          legacy.filter(
            (row) => !known.has(String(row?.id ?? row?.name ?? "")),
          ),
        );
        continue;
      }
      result[table] = db
        .prepare(
          `SELECT * FROM ${table} WHERE team_id=? AND deleted_at IS NULL`,
        )
        .all(req.team.id)
        .map((row) => {
          const copy = { ...row };
          for (const key of ["tags", "extra_data", "messages"])
            if (typeof copy[key] === "string")
              try {
                copy[key] = JSON.parse(copy[key]);
              } catch {}
          return copy;
        });
    } catch (error) {
      result[table] = { error: error.message };
    }
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="zhixun-backup-${Date.now()}.json"`,
  );
  res.json(result);
});
function workspaceExportCollections(req) {
  const collections = workspaceCollections(getDatabase(), req.team.id);
  const state = collections.state || {};
  return {
    customers: collections.customers,
    tasks: collections.tasks,
    feedback: collections.feedback,
    experiences: collections.experiences,
    tags: Array.isArray(state.tags)
      ? state.tags.filter((item) => !item?.deletedAt && !item?.deleted_at)
      : [],
    product_requests: Array.isArray(state.productRequests)
      ? state.productRequests.filter((item) => !item?.deletedAt && !item?.deleted_at)
      : [],
    chat_records: collections.chats,
    sales_statuses: collections.statuses,
    customer_status_history: Array.isArray(state.customerStatusHistory)
      ? state.customerStatusHistory
      : [],
  };
}

function resolveTeamId(db, table, teamId, originalId, idMap) {
  if (!originalId) return null;
  const mapped = idMap.get(String(originalId));
  if (mapped) return mapped;
  return (
    db
      .prepare(
        `SELECT id FROM ${table} WHERE id=? AND team_id=? AND deleted_at IS NULL`,
      )
      .get(originalId, teamId)?.id || null
  );
}
function handleImport(req, res) {
  const db = getDatabase(),
    payload = req.body || {},
    userId = req.user.id,
    teamId = req.team.id;
  const results = Object.fromEntries(TABLES.map((x) => [x, 0]));
  const customerIds = new Map(),
    feedbackIds = new Map(),
    events = [];
  const customerPayload = Array.isArray(payload.customers) ? payload.customers : [];
  for (const [customerIndex, customerPayloadRow] of customerPayload.entries()) {
    const existing = findImportedCustomer(db, teamId, customerPayloadRow);
    if (existing && !canWriteCustomer(db, req, existing)) {
      return res.status(403).json({
        error: '当前账号没有修改该客户的权限',
        customerId: String(existing.id),
        customerName: existing.name || '',
        row: customerIndex + 1,
      });
    }
  }
  db.transaction(() => {
    const common = [userId, teamId, userId, userId];
    const statuses = Array.isArray(payload.sales_statuses)
      ? payload.sales_statuses
      : [];
    const insertStatus = db.prepare(
      "INSERT OR IGNORE INTO sales_statuses(user_id,team_id,created_by_user_id,updated_by_user_id,version,name,color,sort_order,is_funnel,is_enabled) VALUES(?,?,?,?,1,?,?,?,?,?)",
    );
    statuses.forEach((s, i) => {
      const name = String(s.name || "").trim();
      if (name && name !== oldPendingStatus) {
        insertStatus.run(
          ...common,
          name,
          s.color || "#315efb",
          s.sort_order ?? i,
          s.is_funnel ? 1 : 0,
          s.is_enabled === 0 ? 0 : 1,
        );
        results.sales_statuses++;
      }
    });
    const insertCustomer = db.prepare(
      `INSERT INTO customers(
        user_id, team_id, created_by_user_id, updated_by_user_id, version,
        name, province, sales_status, phone, identity, qq, org_name,
        wechat_nickname, wechat_id, douyin_nickname, douyin_id,
        channel_account, official_account, address, video_account,
        public_account, city, notes, approval_status, source, level,
        status, tags, extra_data
      ) VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [customerIndex, c] of customerPayload.entries()) {
      const fields = importCustomerFields(c),
        name = fields.name;
      if (!name) continue;
      const existing = findImportedCustomer(db, teamId, c);
      if (existing) {
        const oldSalesStatus = existing.sales_status,
          changed = updateImportedCustomer(db, existing, fields, userId);
        if (
          changed &&
          fields.sales_status &&
          oldSalesStatus !== fields.sales_status
        ) {
          db.prepare(
            `INSERT INTO customer_status_history(user_id,team_id,created_by_user_id,updated_by_user_id,customer_id,operator_user_id,from_status,to_status,reason,source,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,'import',?,CURRENT_TIMESTAMP)`,
          ).run(
            userId,
            teamId,
            userId,
            userId,
            existing.id,
            userId,
            oldSalesStatus || "",
            fields.sales_status,
            "旧版备份导入覆盖",
            requestId(req, `customer-${c.id ?? customerIndex}`),
          );
        }
        if (c.id !== undefined) customerIds.set(String(c.id), existing.id);
        results.customers++;
        results.updated_customers = (results.updated_customers || 0) + 1;
        continue;
      }
      const r = insertCustomer.run(
        ...common,
        name,
        fields.province,
        fields.sales_status || "新客户",
        fields.phone,
        fields.identity,
        fields.qq,
        fields.org_name,
        fields.wechat_nickname,
        fields.wechat_id,
        fields.douyin_nickname,
        fields.douyin_id,
        fields.channel_account,
        fields.official_account,
        fields.address,
        fields.video_account,
        fields.public_account,
        fields.city,
        fields.notes,
        c.approval_status || c.approval || "正式",
        fields.source,
        fields.level || "潜在客户",
        c.status || "新线索",
        jsonText(fields.tags, []),
        jsonText(fields.extra_data, {}),
      );
      if (c.id !== undefined) customerIds.set(String(c.id), r.lastInsertRowid);
      results.customers++;
      results.added_customers = (results.added_customers || 0) + 1;
    }
    const insertFeedback = db.prepare(
      "INSERT INTO feedback(user_id,team_id,created_by_user_id,updated_by_user_id,version,customer_id,customer_name,province,tags,issue_type,content,priority,assignee,due_date,resolved_at,status) VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const x of Array.isArray(payload.feedback) ? payload.feedback : []) {
      if (!x.content) continue;
      const r = insertFeedback.run(
        ...common,
        resolveTeamId(
          db,
          "customers",
          teamId,
          x.customer_id || x.customerId,
          customerIds,
        ),
        x.customer_name || "",
        normalizeProvince(x.province),
        jsonText(x.tags, []),
        x.issue_type || x.type || "其他",
        x.content,
        x.priority || "普通",
        x.assignee || "",
        x.due_date || x.dueDate || null,
        x.resolved_at || null,
        x.status || "待处理",
      );
      if (x.id !== undefined) feedbackIds.set(String(x.id), r.lastInsertRowid);
      results.feedback++;
    }
    const insertTask = db.prepare(
      "INSERT INTO tasks(user_id,team_id,created_by_user_id,updated_by_user_id,version,customer_id,feedback_id,title,description,task_type,status,priority,due_date,completed_at) VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?)",
    );
    for (const x of Array.isArray(payload.tasks) ? payload.tasks : []) {
      if (!x.title) continue;
      insertTask.run(
        ...common,
        resolveTeamId(
          db,
          "customers",
          teamId,
          x.customer_id || x.customerId,
          customerIds,
        ),
        resolveTeamId(
          db,
          "feedback",
          teamId,
          x.feedback_id || x.feedbackId,
          feedbackIds,
        ),
        x.title,
        x.description || "",
        x.task_type || x.type || "",
        x.status || "待办",
        x.priority || "普通",
        x.due_date || x.dueDate || null,
        x.completed_at || x.completedAt || null,
      );
      results.tasks++;
    }
    const simple = [
      [
        "experiences",
        "INSERT INTO experiences(user_id,team_id,created_by_user_id,updated_by_user_id,version,title,content,category,tags) VALUES(?,?,?,?,1,?,?,?,?)",
        (x) => [
          x.title,
          x.content || "",
          x.category || "",
          jsonText(x.tags, []),
        ],
      ],
      [
        "tags",
        "INSERT INTO tags(user_id,team_id,created_by_user_id,updated_by_user_id,version,name,color,category) VALUES(?,?,?,?,1,?,?,?)",
        (x) => [x.name, x.color || "", x.category || ""],
      ],
      [
        "product_requests",
        "INSERT INTO product_requests(user_id,team_id,created_by_user_id,updated_by_user_id,version,title,description,priority,status) VALUES(?,?,?,?,1,?,?,?,?)",
        (x) => [
          x.title,
          x.description || "",
          x.priority || "普通",
          x.status || "规划中",
        ],
      ],
    ];
    for (const [table, sql, values] of simple) {
      const ins = db.prepare(sql);
      for (const x of Array.isArray(payload[table]) ? payload[table] : []) {
        if (!(x.title || x.name)) continue;
        ins.run(...common, ...values(x));
        results[table]++;
      }
    }
    const insertChat = db.prepare(
      "INSERT INTO chat_records(user_id,team_id,created_by_user_id,updated_by_user_id,version,customer_id,file_name,messages) VALUES(?,?,?,?,1,?,?,?)",
    );
    for (const x of Array.isArray(payload.chat_records)
      ? payload.chat_records
      : []) {
      const customerId = resolveTeamId(
        db,
        "customers",
        teamId,
        x.customer_id || x.customerId,
        customerIds,
      );
      if (!customerId) continue;
      insertChat.run(
        ...common,
        customerId,
        x.file_name || x.fileName || "",
        jsonText(x.messages, []),
      );
      results.chat_records++;
    }
    const insertHistory = db.prepare(
      `INSERT INTO customer_status_history(user_id,team_id,created_by_user_id,updated_by_user_id,version,customer_id,operator_user_id,from_status,to_status,reason,source,request_id,created_at) VALUES(?,?,?,?,1,?,?,?,?,?,'import',?,?)`,
    );
    let hi = 0;
    for (const x of Array.isArray(payload.customer_status_history)
      ? payload.customer_status_history
      : []) {
      const customerId = resolveTeamId(
        db,
        "customers",
        teamId,
        x.customer_id || x.customerId,
        customerIds,
      );
      if (!customerId) continue;
      insertHistory.run(
        ...common,
        customerId,
        userId,
        x.from_status || "",
        normalizedSalesStatus(x.to_status),
        x.reason || "",
        requestId(req, `history-${hi++}`),
        x.created_at || new Date().toISOString(),
      );
      results.customer_status_history++;
    }
    events.push(
      reconcileLegacyTables(db, req, [
        "customers",
        "tasks",
        "feedback",
        "chat_records",
        "experiences",
        "tags",
        "product_requests",
      ]),
    );
  })();
  publishEvents(teamId, events);
  res.json({ message: "导入完成", results });
}
router.post("/import", handleImport);
router.post("/migrate", handleImport);
router.post("/reset", adminRequired, async (req, res) => {
  const rid = requestId(req);
  if (req.body?.confirmation !== CONFIRMATION_TEXT) {
    return res
      .status(400)
      .json({ error: `请输入完全一致的确认文字：${CONFIRMATION_TEXT}` });
  }
  try {
    const result = await resetBusinessData({
      req,
      confirmation: req.body.confirmation,
      requestId: rid,
    });
    publishEvents(req.team.id, result.events || []);
    delete result.events;
    return res.json(result);
  } catch (error) {
    const status =
      Number(error.statusCode) >= 400 && Number(error.statusCode) < 500
        ? error.statusCode
        : 500;
    console.error("[data/reset]", error);
    return res
      .status(status)
      .json({ error: error.message || "清空业务数据失败，原数据未修改" });
  }
});
module.exports = router;
