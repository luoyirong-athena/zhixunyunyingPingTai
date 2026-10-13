function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function normalizeKnowledgeType(value) {
  const type = String(value || '').trim().toLowerCase();
  const aliases = {
    script: 'script', scripts: 'script',
    experience: 'experience', experiences: 'experience',
    material: 'material', materials: 'material'
  };
  return aliases[type] || '';
}

function normalizeKnowledgeId(type, value) {
  const id = String(value == null ? '' : value).trim();
  if (normalizeKnowledgeType(type) === 'material' && /^server_\d+$/i.test(id)) return id.slice(7);
  return id;
}

function workspaceState(db, teamId) {
  const row = db.prepare('SELECT state_json FROM workspace_states WHERE team_id = ?').get(teamId);
  const state = parseJson(row?.state_json, {});
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function materialItem(row) {
  if (!row) return null;
  return {
    type: 'material',
    id: String(row.id),
    serverId: row.id,
    title: row.original_name || '未命名文件',
    category: row.category || '资料文件',
    scene: '',
    content: '',
    description: `${String(row.extension || '文件').toUpperCase()} · ${Number(row.size_bytes || 0)} bytes`,
    extension: String(row.extension || '').toLowerCase(),
    sizeBytes: Number(row.size_bytes || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    downloadUrl: `/api/materials/${row.id}/download`,
    previewUrl: `/api/materials/${row.id}/preview`
  };
}

function stateItem(type, item) {
  if (!item) return null;
  const normalizedType = normalizeKnowledgeType(type);
  const id = normalizeKnowledgeId(normalizedType, item.serverId || item.id);
  return {
    type: normalizedType,
    id,
    serverId: item.serverId || null,
    title: item.title || item.original_name || item.name || '未命名内容',
    category: item.category || (normalizedType === 'material' ? '资料文件' : '未分类'),
    scene: item.scene || '',
    content: item.content || '',
    description: item.description || '',
    extension: String(item.extension || item.original_name || item.name || '').split('.').pop().toLowerCase(),
    sizeBytes: Number(item.size_bytes || item.size || 0),
    createdAt: item.createdAt || item.created_at || '',
    updatedAt: item.updatedAt || item.updated_at || item.createdAt || item.created_at || '',
    downloadUrl: item.download_url || (item.serverId ? `/api/materials/${item.serverId}/download` : ''),
    previewUrl: item.serverId ? `/api/materials/${item.serverId}/preview` : ''
  };
}

function listKnowledgeItems(db, teamId, types = ['script', 'experience', 'material']) {
  const requested = new Set(types.map(normalizeKnowledgeType).filter(Boolean));
  const state = workspaceState(db, teamId);
  const items = [];
  if (requested.has('script')) items.push(...(Array.isArray(state.scripts) ? state.scripts : []).map(item => stateItem('script', item)));
  if (requested.has('experience')) {
    const seen = new Set();
    for (const item of Array.isArray(state.experiences) ? state.experiences : []) {
      const normalized = stateItem('experience', item);
      if (normalized) { items.push(normalized); seen.add(normalized.id); }
    }
    const rows = db.prepare('SELECT * FROM experiences WHERE team_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC').all(teamId);
    for (const row of rows) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      items.push({
        type: 'experience', id, title: row.title || '未命名内容', category: row.category || '未分类',
        scene: '', content: row.content || '', description: '', createdAt: row.created_at, updatedAt: row.updated_at
      });
    }
  }
  if (requested.has('material')) {
    const rows = db.prepare('SELECT * FROM materials_files WHERE team_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(teamId);
    const seen = new Set();
    for (const row of rows) { const normalized = materialItem(row); items.push(normalized); seen.add(normalized.id); }
    for (const item of Array.isArray(state.materials) ? state.materials : []) {
      const normalized = stateItem('material', item);
      if (normalized && !seen.has(normalized.id)) items.push(normalized);
    }
  }
  return items.filter(Boolean);
}

function resolveKnowledgeItem(db, teamId, type, id) {
  const normalizedType = normalizeKnowledgeType(type);
  const normalizedId = normalizeKnowledgeId(normalizedType, id);
  if (!normalizedType || !normalizedId) return null;
  if (normalizedType === 'material' && /^\d+$/.test(normalizedId)) {
    const row = db.prepare('SELECT * FROM materials_files WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(normalizedId, teamId);
    if (row) return materialItem(row);
  }
  return listKnowledgeItems(db, teamId, [normalizedType]).find(item => item.id === normalizedId) || null;
}

function searchKnowledgeItems(db, teamId, { types = [], query = '', limit = 100 } = {}) {
  const normalizedTypes = (Array.isArray(types) ? types : String(types || '').split(','))
    .map(normalizeKnowledgeType).filter(Boolean);
  const list = listKnowledgeItems(db, teamId, normalizedTypes.length ? normalizedTypes : ['script', 'experience', 'material']);
  const needle = String(query || '').trim().toLowerCase();
  const max = Math.max(1, Math.min(Number(limit) || 100, 300));
  return list.filter(item => !needle || [item.title, item.category, item.scene, item.content, item.description, item.extension]
    .some(value => String(value || '').toLowerCase().includes(needle))).slice(0, max);
}

module.exports = {
  normalizeKnowledgeType,
  normalizeKnowledgeId,
  workspaceState,
  listKnowledgeItems,
  resolveKnowledgeItem,
  searchKnowledgeItems
};
