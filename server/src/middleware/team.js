const { getDatabase, DEFAULT_TEAM_CODE = 'operations-default' } = require('../config/database');

function resolveTeamContext(req, res, next) {
  try {
    const db = getDatabase();
    const membership = db.prepare(`
      SELECT t.id, t.code, t.name, tm.role, u.display_name, u.username AS member_username
      FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = ? AND tm.status = 'active' AND t.status = 'active' AND t.code = ?
      LIMIT 1
    `).get(req.user.id, DEFAULT_TEAM_CODE);

    if (!membership) {
      const team = db.prepare("SELECT id, code, name FROM teams WHERE code = ? AND status = 'active'").get(DEFAULT_TEAM_CODE);
      if (!team) return res.status(503).json({ error: '运营团队尚未初始化' });
      const role = req.user.role === 'admin' ? 'admin' : 'member';
      db.prepare("INSERT OR IGNORE INTO team_members (team_id, user_id, role, status) VALUES (?, ?, ?, 'active')")
        .run(team.id, req.user.id, role);
      req.team = { ...team, role };
      return next();
    }

    req.team = { id: membership.id, code: membership.code, name: membership.name, role: membership.role };
    req.user = { ...req.user, display_name: membership.display_name || '', username: membership.member_username || req.user.username };
    next();
  } catch (error) {
    next(error);
  }
}

function requireTeamRole(...roles) {
  return (req, res, next) => {
    if (!req.team || !roles.includes(req.team.role)) {
      return res.status(403).json({ error: '当前团队角色无权执行此操作' });
    }
    next();
  };
}

function enforceTeamWriteByMethod(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.team?.role !== 'viewer') return next();
  return res.status(403).json({ error: '当前团队角色为只读成员，不能修改数据' });
}

module.exports = { resolveTeamContext, requireTeamRole, enforceTeamWriteByMethod };
