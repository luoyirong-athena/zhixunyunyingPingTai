const DEFAULT_STATUS_RULES = [
  { names: ['已付费', '已成交'], score: 0, excluded: true },
  { names: ['已流失', '已关闭'], score: 0, excluded: true },
  { names: ['高意向'], score: 30 },
  { names: ['新客户', '尚未触达', '新线索'], score: 20 },
  { names: ['已加微信', '微信待通过'], score: 20 },
  { names: ['试用中'], score: 20 },
  { names: ['已联系', '已抖音私信'], score: 15 },
  { names: ['待维护'], score: 10 }
];

const DEFAULT_PRIORITY_CONFIG = {
  weights: { followers: 40, evidence: 30, status: 30 },
  thresholds: { first: 80, second: 60, third: 40 },
  followers: [
    { min: 10000, score: 40 },
    { min: 5000, score: 20 }
  ],
  evidence: [
    { min: 6, score: 30 }
  ]
};

function parseFollowers(value) {
  if (value === null || value === undefined) return 0;
  const raw = String(value).trim().toLowerCase().replace(/[，,\s]/g, '');
  if (!raw) return 0;
  const match = raw.match(/([0-9]+(?:\.[0-9]+)?)(万|w|千|k)?/i);
  if (!match) return 0;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return 0;
  const unit = String(match[2] || '').toLowerCase();
  const multiplier = unit === '万' || unit === 'w' ? 10000 : unit === '千' || unit === 'k' ? 1000 : 1;
  return Math.max(0, Math.round(number * multiplier));
}

function scoreByTiers(value, tiers) {
  const sorted = [...(tiers || [])].sort((a, b) => (b.min || 0) - (a.min || 0));
  for (const tier of sorted) {
    if (value >= (tier.min || 0)) return tier.score || 0;
  }
  return 0;
}

function followerScore(value, config) {
  const followers = parseFollowers(value);
  const tiers = (config && config.followers) ? config.followers : DEFAULT_PRIORITY_CONFIG.followers;
  return scoreByTiers(followers, tiers);
}

function normalizeEvidenceRule(tiers, budget = DEFAULT_PRIORITY_CONFIG.weights.evidence) {
  const cleaned = (Array.isArray(tiers) ? tiers : [])
    .map(tier => ({
      min: Math.max(1, Number(tier?.min) || 0),
      score: Math.max(0, Number(tier?.score) || 0)
    }))
    .filter(tier => tier.min > 0)
    .sort((a, b) => b.min - a.min);
  const source = cleaned[0] || DEFAULT_PRIORITY_CONFIG.evidence[0];
  return {
    min: source.min,
    score: Math.min(Math.max(0, Number(budget) || 0), source.score)
  };
}

function evidenceScore(qualified, config) {
  const rule = normalizeEvidenceRule(config?.evidence, config?.weights?.evidence);
  return qualified === true ? rule.score : 0;
}

function evidenceQualificationThreshold(config = null) {
  return normalizeEvidenceRule(config?.evidence, config?.weights?.evidence).min;
}

function momentsOrdersQualified(customer, evidenceTotal, priorityConfig) {
  if (typeof customer?.moments_orders_qualified === 'boolean') {
    return customer.moments_orders_qualified;
  }
  if (customer && Object.prototype.hasOwnProperty.call(customer, 'moments_orders_qualified') && customer.moments_orders_qualified == null) {
    return null;
  }
  return Math.max(0, Number(evidenceTotal) || 0) >= evidenceQualificationThreshold(priorityConfig);
}

function statusRule(status, configs = []) {
  const name = String(status || '').trim();
  const configured = configs.find(item => String(item.name || '') === name);
  if (configured) {
    return {
      score: Math.max(0, Math.min(100, Number(configured.priority_score ?? 10) || 0)),
      excluded: Number(configured.priority_excluded) === 1 || Number(configured.priority_enabled) === 0
    };
  }
  const exact = DEFAULT_STATUS_RULES.find(rule => rule.names.includes(name));
  if (exact) return { score: exact.score, excluded: Boolean(exact.excluded) };
  const lower = name.toLowerCase();
  if (lower.includes('付费') || lower.includes('成交') || lower.includes('流失') || lower.includes('关闭')) return { score: 0, excluded: true };
  if (lower.includes('意向')) return { score: 30, excluded: false };
  if (lower.includes('微信')) return { score: 20, excluded: false };
  if (lower.includes('试用')) return { score: 20, excluded: false };
  return { score: 10, excluded: false };
}

function ladderFor(score, thresholds) {
  const t = thresholds || DEFAULT_PRIORITY_CONFIG.thresholds;
  if (score >= (t.first || 80)) return { key: 'first', label: '第一梯队', rank: 1 };
  if (score >= (t.second || 60)) return { key: 'second', label: '第二梯队', rank: 2 };
  if (score >= (t.third || 40)) return { key: 'third', label: '第三梯队', rank: 3 };
  return { key: 'cultivate', label: '待培养', rank: 4 };
}

function isDeleted(customer) {
  return Boolean(customer?.deletedAt || customer?.deleted_at || customer?.isDeleted || customer?.is_deleted);
}

function isOfficial(customer) {
  return String(customer?.approval || customer?.approval_status || '正式') !== '待确认';
}

function computeCustomerPriority(customer, evidenceCount = 0, configs = [], priorityConfig = null) {
  const followers = parseFollowers(customer?.douyin_followers);
  const followerPoints = followerScore(customer?.douyin_followers, priorityConfig);
  const evidence = Math.max(0, Number(evidenceCount) || 0);
  const evidenceTotal = evidence + Math.max(0, Number(customer?.moments_orders) || 0);
  const status = statusRule(customer?.sales_status || customer?.status, configs);
  const evidenceQualification = evidenceQualificationThreshold(priorityConfig);
  const momentsQualified = momentsOrdersQualified(customer, evidenceTotal, priorityConfig);
  const evidencePoints = evidenceScore(momentsQualified, priorityConfig);
  const score = followerPoints + evidencePoints + status.score;
  const ladder = ladderFor(score, priorityConfig?.thresholds);
  return {
    customerId: String(customer?.id ?? ''),
    name: String(customer?.name || '未命名客户'),
    province: customer?.province || '',
    city: customer?.city || '',
    identity: customer?.identity || '',
    orgName: customer?.org_name || '',
    salesStatus: customer?.sales_status || customer?.status || '未设置',
    salesStatusScore: status.score,
    salesStatusExcluded: status.excluded,
    douyinFollowers: followers,
    douyinFollowersRaw: customer?.douyin_followers ?? '',
    evidenceCount: evidence,
    evidenceTotal,
    evidenceQualificationThreshold: evidenceQualification,
    momentsOrdersQualified: momentsQualified,
    score,
    ladder: ladder.key,
    ladderLabel: ladder.label,
    ladderRank: ladder.rank,
    scoreBreakdown: {
      followers: followerPoints,
      evidence: evidencePoints,
      salesStatus: status.score
    },
    updatedAt: customer?.updatedAt || customer?.updated_at || customer?.createdAt || customer?.created_at || ''
  };
}

function prioritySignature(item) {
  if (!item) return '';
  return [item.score, item.ladder, item.douyinFollowers, item.evidenceCount, item.momentsOrdersQualified, item.salesStatus].join('|');
}

function getWorkspaceState(db, teamId) {
  const row = db.prepare('SELECT state_json, version FROM workspace_states WHERE team_id = ?').get(teamId);
  if (!row || Number(row.version || 0) <= 0) return { version: 0, customers: [] };
  try {
    const state = JSON.parse(row.state_json || '{}');
    return { version: Number(row.version || 0), customers: Array.isArray(state.customers) ? state.customers : [] };
  } catch (_) {
    return { version: Number(row.version || 0), customers: [] };
  }
}

function relationalCustomers(db, teamId) {
  try {
    return db.prepare(`SELECT * FROM customers WHERE team_id = ?`).all(teamId).map(row => ({
      ...row,
      id: String(row.id),
      approval: row.approval_status || '正式',
      approval_status: row.approval_status || '正式',
      deletedAt: row.deleted_at || '',
      updatedAt: row.updated_at || row.created_at || '',
      createdAt: row.created_at || ''
    }));
  } catch (_) {
    return [];
  }
}

function teamCustomers(db, teamId) {
  const workspace = getWorkspaceState(db, teamId);
  const workspaceCustomers = new Map();
  (workspace.customers || []).forEach(customer => {
    const id = String(customer?.id ?? '');
    // Preserve the existing customer-list dedupe rule: the first occurrence wins.
    if (id && !workspaceCustomers.has(id)) workspaceCustomers.set(id, customer);
  });
  const merged = new Map(workspaceCustomers);
  relationalCustomers(db, teamId).forEach(customer => {
    const id = String(customer.id);
    if (!workspaceCustomers.has(id)) merged.set(id, customer);
  });
  return { version: workspace.version, customers: [...merged.values()] };
}

function evidenceCounts(db, teamId) {
  const rows = db.prepare(`SELECT customer_id, COUNT(*) count
    FROM customer_evidence
    WHERE team_id = ? AND evidence_type = 'moments_order_screenshot' AND deleted_at IS NULL
    GROUP BY customer_id`).all(teamId);
  return new Map(rows.map(row => [String(row.customer_id), Number(row.count || 0)]));
}

function activeStatusConfigs(db, teamId) {
  try {
    return db.prepare(`SELECT name, priority_enabled, priority_score, priority_excluded
      FROM sales_statuses
      WHERE team_id = ? AND deleted_at IS NULL AND is_enabled = 1`).all(teamId);
  } catch (_) {
    return [];
  }
}

function getPriorityConfig(db, teamId) {
  try {
    const row = db.prepare('SELECT priority_config FROM teams WHERE id = ?').get(teamId);
    if (row && row.priority_config) {
      const parsed = JSON.parse(row.priority_config);
      const defW = DEFAULT_PRIORITY_CONFIG.weights, defT = DEFAULT_PRIORITY_CONFIG.thresholds;
      const weights = {
        followers: Number(parsed.weights?.followers) || defW.followers,
        evidence: Number(parsed.weights?.evidence) || defW.evidence,
        status: Number(parsed.weights?.status) || defW.status
      };
      return {
        weights,
        thresholds: {
          first: Number(parsed.thresholds?.first) || defT.first,
          second: Number(parsed.thresholds?.second) || defT.second,
          third: Number(parsed.thresholds?.third) || defT.third
        },
        followers: parsed.followers || DEFAULT_PRIORITY_CONFIG.followers,
        evidence: [normalizeEvidenceRule(parsed.evidence, weights.evidence)]
      };
    }
  } catch (_) {}
  return { weights: {...DEFAULT_PRIORITY_CONFIG.weights}, thresholds: {...DEFAULT_PRIORITY_CONFIG.thresholds}, followers: DEFAULT_PRIORITY_CONFIG.followers, evidence: DEFAULT_PRIORITY_CONFIG.evidence.map(rule => ({...rule})) };
}

function savePriorityConfig(db, teamId, config) {
  const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const weights = {
    followers: Math.max(0, Math.min(100, numberOr(config.weights?.followers, DEFAULT_PRIORITY_CONFIG.weights.followers))),
    evidence: Math.max(0, Math.min(100, numberOr(config.weights?.evidence, DEFAULT_PRIORITY_CONFIG.weights.evidence))),
    status: Math.max(0, Math.min(100, numberOr(config.weights?.status, DEFAULT_PRIORITY_CONFIG.weights.status)))
  };
  const clean = {
    weights,
    thresholds: {
      first: Math.max(1, Math.min(99, Number(config.thresholds?.first) || DEFAULT_PRIORITY_CONFIG.thresholds.first)),
      second: Math.max(1, Math.min(99, Number(config.thresholds?.second) || DEFAULT_PRIORITY_CONFIG.thresholds.second)),
      third: Math.max(1, Math.min(99, Number(config.thresholds?.third) || DEFAULT_PRIORITY_CONFIG.thresholds.third))
    },
    followers: Array.isArray(config.followers) ? config.followers.map(t => ({ min: Math.max(0, Number(t.min) || 0), score: Math.max(0, Number(t.score) || 0) })) : DEFAULT_PRIORITY_CONFIG.followers,
    evidence: [normalizeEvidenceRule(config.evidence, weights.evidence)]
  };
  db.prepare('UPDATE teams SET priority_config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(clean), teamId);
  return clean;
}

function listPriorityCustomers(db, teamId, query = {}) {
  const source = teamCustomers(db, teamId);
  const counts = evidenceCounts(db, teamId);
  const configs = activeStatusConfigs(db, teamId);
  const priorityConfig = getPriorityConfig(db, teamId);
  const seen = new Set();
  const all = [];
  for (const customer of source.customers) {
    const id = String(customer?.id ?? '');
    if (!id || seen.has(id) || !isOfficial(customer) || isDeleted(customer)) continue;
    seen.add(id);
    const evidenceCount = counts.get(id) || 0;
    const item = computeCustomerPriority(customer, evidenceCount, configs, priorityConfig);
    if (item.salesStatusExcluded) continue;
    all.push(item);
  }
  const status = String(query.sales_status || '').trim();
  const province = String(query.province || '').trim();
  const ladder = String(query.ladder || '').trim();
  let filtered = all;
  if (status) filtered = filtered.filter(item => item.salesStatus === status);
  if (province) filtered = filtered.filter(item => item.province === province);
  if (ladder) filtered = filtered.filter(item => ladder === '1' ? item.ladder === 'first' : ladder === '2' ? item.ladder === 'second' : ladder === '3' ? item.ladder === 'third' : ladder === 'cultivate');
  filtered.sort((a, b) => b.score - a.score || b.salesStatusScore - a.salesStatusScore || b.evidenceCount - a.evidenceCount || b.douyinFollowers - a.douyinFollowers || String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.name.localeCompare(b.name, 'zh-CN'));
  const ladderCounts = { first: 0, second: 0, third: 0, cultivate: 0 };
  all.forEach(item => { ladderCounts[item.ladder] = (ladderCounts[item.ladder] || 0) + 1; });
  const provinceCounts = all.reduce((counts, item) => {
    const province = String(item.province || '').trim() || '未填写省份';
    counts[province] = (counts[province] || 0) + 1;
    return counts;
  }, {});
  const provinces = Object.entries(provinceCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .map(([name, count]) => ({ name, count }));
  const limit = Math.min(200, Math.max(1, Number(query.limit || 100) || 100));
  const offset = Math.max(0, Number(query.offset || 0) || 0);
  return {
    total: all.length,
    ladderCounts,
    provinceCounts,
    provinces,
    customers: filtered.slice(offset, offset + limit),
    version: source.version,
    generatedAt: new Date().toISOString()
  };
}

function priorityMap(db, teamId, customers) {
  const counts = evidenceCounts(db, teamId);
  const configs = activeStatusConfigs(db, teamId);
  const priorityConfig = getPriorityConfig(db, teamId);
  return new Map((customers || []).map(customer => {
    const id = String(customer?.id ?? '');
    const evidenceCount = counts.get(id) || 0;
    return [id, computeCustomerPriority(customer, evidenceCount, configs, priorityConfig)];
  }));
}

module.exports = {
  parseFollowers,
  followerScore,
  evidenceScore,
  evidenceQualificationThreshold,
  momentsOrdersQualified,
  scoreByTiers,
  ladderFor,
  computeCustomerPriority,
  prioritySignature,
  getWorkspaceState,
  teamCustomers,
  listPriorityCustomers,
  priorityMap,
  activeStatusConfigs,
  getPriorityConfig,
  savePriorityConfig,
  DEFAULT_PRIORITY_CONFIG,
  isDeleted,
  isOfficial
};
