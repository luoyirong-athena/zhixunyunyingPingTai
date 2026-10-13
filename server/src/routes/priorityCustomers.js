const express = require('express');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { recordChange, publishEvents, requestId } = require('../services/teamEvents');
const { updateWorkspaceState } = require('../services/workspaceLegacyBridge');
const {
  listPriorityCustomers,
  getPriorityConfig,
  savePriorityConfig
} = require('../services/priorityCustomers');

const router = express.Router();
router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);

router.get('/', (req, res) => {
  const db = getDatabase();
  const data = listPriorityCustomers(db, req.team.id, req.query);
  data.config = getPriorityConfig(db, req.team.id);
  res.json(data);
});

router.put('/config', (req, res) => {
  const db = getDatabase();
  const config = req.body || {};
  const requestedWeights = config.weights || {};
  const total = ['followers', 'evidence', 'status']
    .reduce((sum, key) => sum + (Number(requestedWeights[key]) || 0), 0);
  if (total !== 100) return res.status(400).json({ error: `三大维度分值占比合计必须为100%，当前为 ${total}%` });
  const events = [];
  let saved;
  db.transaction(() => {
    const before = getPriorityConfig(db, req.team.id);
    saved = savePriorityConfig(db, req.team.id, config);
    const workspace = updateWorkspaceState(db, req, previousState => {
      const settings = { ...(previousState.settings || {}), priorityConfig: saved };
      return {
        state: { ...previousState, settings },
        patch: { replace: { settings }, arrays: {} }
      };
    }, 'priority_config');
    events.push(recordChange(db, req, {
      entityType: 'priority_config', entityId: req.team.id, action: 'priority_config.updated',
      version: workspace.version, before, after: saved,
      payload: { requestId: requestId(req, 'priority-config') }
    }));
    events.push(workspace.event);
  })();
  publishEvents(req.team.id, events);
  res.json({ message: '评分配置已保存', config: saved });
});

module.exports = router;
