const express = require('express');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { recordChange, publishEvents } = require('../services/teamEvents');
const {
  normalizeKnowledgeType,
  normalizeKnowledgeId,
  listKnowledgeItems,
  resolveKnowledgeItem,
  searchKnowledgeItems
} = require('../services/knowledgeCatalog');

const router = express.Router();
router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);

function relationRow(row, catalogMap) {
  const sourceKey = `${row.source_type}:${row.source_id}`;
  const targetKey = `${row.target_type}:${row.target_id}`;
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    targetType: row.target_type,
    targetId: row.target_id,
    relationType: row.relation_type || 'reference',
    version: Number(row.version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceItem: catalogMap?.get(sourceKey) || null,
    targetItem: catalogMap?.get(targetKey) || null
  };
}

function catalogMap(db, teamId) {
  return new Map(listKnowledgeItems(db, teamId).map(item => [`${item.type}:${item.id}`, item]));
}

function canonicalRelation(sourceType, sourceId, targetType, targetId) {
  const aType = normalizeKnowledgeType(sourceType);
  const bType = normalizeKnowledgeType(targetType);
  const aId = normalizeKnowledgeId(aType, sourceId);
  const bId = normalizeKnowledgeId(bType, targetId);
  if (aType === 'experience' && ['script', 'material'].includes(bType)) {
    return { sourceType: aType, sourceId: aId, targetType: bType, targetId: bId };
  }
  if (bType === 'experience' && ['script', 'material'].includes(aType)) {
    return { sourceType: bType, sourceId: bId, targetType: aType, targetId: aId };
  }
  return null;
}

router.get('/catalog', (req, res) => {
  const db = getDatabase();
  const types = String(req.query.types || '').split(',').filter(Boolean);
  const data = searchKnowledgeItems(db, req.team.id, {
    types,
    query: req.query.q || '',
    limit: req.query.limit || 200
  });
  res.json({ data });
});

router.get('/relations', (req, res) => {
  const db = getDatabase();
  const rows = db.prepare(`SELECT * FROM knowledge_relations
    WHERE team_id = ? AND deleted_at IS NULL
    ORDER BY updated_at DESC, id DESC`).all(req.team.id);
  const map = catalogMap(db, req.team.id);
  res.json({ data: rows.map(row => relationRow(row, map)) });
});

router.get('/:type/:id/relations', (req, res) => {
  const type = normalizeKnowledgeType(req.params.type);
  const id = normalizeKnowledgeId(type, req.params.id);
  if (!type || !id) return res.status(400).json({ error: '内容类型或ID不正确' });
  const db = getDatabase();
  const rows = db.prepare(`SELECT * FROM knowledge_relations
    WHERE team_id = ? AND deleted_at IS NULL
      AND ((source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?))
    ORDER BY updated_at DESC, id DESC`).all(req.team.id, type, id, type, id);
  const map = catalogMap(db, req.team.id);
  res.json({
    item: resolveKnowledgeItem(db, req.team.id, type, id),
    data: rows.map(row => relationRow(row, map))
  });
});

router.put('/:type/:id/relations', (req, res) => {
  const ownerType = normalizeKnowledgeType(req.params.type);
  const ownerId = normalizeKnowledgeId(ownerType, req.params.id);
  if (ownerType !== 'experience' || !ownerId) return res.status(400).json({ error: '本期仅支持为经验总结设置关联内容' });
  if (!Array.isArray(req.body?.relations)) return res.status(400).json({ error: 'relations 必须为数组' });

  const desired = new Map();
  for (const input of req.body.relations) {
    const canonical = canonicalRelation(ownerType, ownerId, input.targetType, input.targetId);
    if (!canonical || !canonical.targetId) return res.status(400).json({ error: '只能关联常用话术或资料库内容' });
    desired.set(`${canonical.targetType}:${canonical.targetId}`, canonical);
  }

  const db = getDatabase();
  for (const relation of desired.values()) {
    if (!resolveKnowledgeItem(db, req.team.id, relation.targetType, relation.targetId)) {
      return res.status(400).json({ error: '关联目标不存在、已删除或不属于当前团队' });
    }
  }
  const allBefore = db.prepare(`SELECT * FROM knowledge_relations
    WHERE team_id = ? AND source_type = 'experience' AND source_id = ? AND relation_type = 'reference'`).all(req.team.id, ownerId);
  const byKey = new Map(allBefore.map(row => [`${row.target_type}:${row.target_id}`, row]));
  const events = [];
  let activeRows;

  db.transaction(() => {
    for (const row of allBefore) {
      const key = `${row.target_type}:${row.target_id}`;
      if (!desired.has(key) && !row.deleted_at) {
        db.prepare(`UPDATE knowledge_relations SET deleted_at = CURRENT_TIMESTAMP, deleted_by_user_id = ?,
          updated_by_user_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(req.user.id, req.user.id, row.id);
      }
    }
    for (const [key, relation] of desired) {
      const existing = byKey.get(key);
      if (existing) {
        if (existing.deleted_at) {
          db.prepare(`UPDATE knowledge_relations SET deleted_at = NULL, deleted_by_user_id = NULL,
            updated_by_user_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(req.user.id, existing.id);
        }
      } else {
        db.prepare(`INSERT INTO knowledge_relations
          (team_id, source_type, source_id, target_type, target_id, relation_type, created_by_user_id, updated_by_user_id, version)
          VALUES (?, 'experience', ?, ?, ?, 'reference', ?, ?, 1)`)
          .run(req.team.id, ownerId, relation.targetType, relation.targetId, req.user.id, req.user.id);
      }
    }
    activeRows = db.prepare(`SELECT * FROM knowledge_relations
      WHERE team_id = ? AND source_type = 'experience' AND source_id = ? AND relation_type = 'reference' AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC`).all(req.team.id, ownerId);
    const event = recordChange(db, req, {
      entityType: 'knowledge_relation',
      entityId: `experience:${ownerId}`,
      action: 'knowledge.relations_updated',
      version: Math.max(1, ...activeRows.map(row => Number(row.version || 1))),
      before: allBefore.filter(row => !row.deleted_at).map(row => ({ targetType: row.target_type, targetId: row.target_id })),
      after: activeRows.map(row => ({ targetType: row.target_type, targetId: row.target_id })),
      payload: { ownerType: 'experience', ownerId, relationCount: activeRows.length }
    });
    events.push(event);
  })();

  publishEvents(req.team.id, events);
  const map = catalogMap(db, req.team.id);
  res.json({ data: activeRows.map(row => relationRow(row, map)) });
});

router.delete('/relations/:relationId', (req, res) => {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM knowledge_relations WHERE id = ? AND team_id = ? AND deleted_at IS NULL')
    .get(req.params.relationId, req.team.id);
  if (!row) return res.status(404).json({ error: '关联关系不存在' });
  const events = [];
  let deleted;
  db.transaction(() => {
    db.prepare(`UPDATE knowledge_relations SET deleted_at = CURRENT_TIMESTAMP, deleted_by_user_id = ?,
      updated_by_user_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND team_id = ?`)
      .run(req.user.id, req.user.id, row.id, req.team.id);
    deleted = db.prepare('SELECT * FROM knowledge_relations WHERE id = ?').get(row.id);
    events.push(recordChange(db, req, {
      entityType: 'knowledge_relation', entityId: row.id, action: 'knowledge.relation_deleted',
      version: deleted.version, before: row, after: { deleted_at: deleted.deleted_at },
      payload: { sourceType: row.source_type, sourceId: row.source_id, targetType: row.target_type, targetId: row.target_id }
    }));
  })();
  publishEvents(req.team.id, events);
  res.json({ message: '关联关系已删除，原内容保持不变' });
});

module.exports = router;
