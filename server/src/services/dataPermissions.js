'use strict';

function normalizedId(value) {
  return String(value ?? '').trim();
}

function customerOwnerId(customer) {
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) return '';
  return [customer.created_by_user_id, customer.createdByUserId, customer.user_id, customer.userId]
    .map(normalizedId)
    .find(Boolean) || '';
}

function isAdmin(req) {
  return req?.user?.role === 'admin' || req?.team?.role === 'admin';
}

function resolveCustomerOwnerId(db, teamId, customer) {
  const direct = customerOwnerId(customer);
  if (direct) return direct;
  const username = String(customer?.created_by_username || '').trim();
  if (username) {
    const row = db.prepare(`SELECT u.id FROM users u
      JOIN team_members tm ON tm.user_id = u.id
      WHERE tm.team_id = ? AND tm.status = 'active' AND u.username = ? LIMIT 1`).get(teamId, username);
    if (row) return normalizedId(row.id);
  }
  const displayName = String(customer?.createdBy || customer?.created_by_name || customer?.created_by || '').trim();
  if (displayName) {
    const rows = db.prepare(`SELECT u.id FROM users u
      JOIN team_members tm ON tm.user_id = u.id
      WHERE tm.team_id = ? AND tm.status = 'active' AND (u.display_name = ? OR u.username = ?)
      ORDER BY CASE WHEN u.username = ? THEN 0 ELSE 1 END, u.id LIMIT 2`).all(teamId, displayName, displayName, displayName);
    if (rows.length === 1) return normalizedId(rows[0].id);
  }
  return '';
}

function approvedCustomerPermission(db, teamId, customerId, userId) {
  return db.prepare(`SELECT id FROM customer_data_permissions
    WHERE team_id = ? AND customer_id = ? AND requester_user_id = ? AND status = 'approved'
    LIMIT 1`).get(teamId, normalizedId(customerId), Number(userId));
}

function canWriteCustomer(db, req, customer) {
  if (isAdmin(req)) return true;
  const ownerId = resolveCustomerOwnerId(db, req.team.id, customer);
  // Preserve the original shared-data behaviour for legacy rows whose owner
  // cannot be identified. Newly created rows are always stamped with an owner.
  if (!ownerId) return true;
  if (ownerId === normalizedId(req.user.id)) return true;
  return Boolean(approvedCustomerPermission(db, req.team.id, customer?.id, req.user.id));
}

function changed(left, right) {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

function validateWorkspaceCustomerChanges(db, req, previousState, nextState) {
  const before = new Map((Array.isArray(previousState?.customers) ? previousState.customers : [])
    .filter(Boolean).map((customer) => [normalizedId(customer.id), customer]));
  const after = new Map((Array.isArray(nextState?.customers) ? nextState.customers : [])
    .filter(Boolean).map((customer) => [normalizedId(customer.id), customer]));

  for (const [customerId, previous] of before) {
    const next = after.get(customerId);
    if (next && !changed(previous, next)) continue;
    if (!canWriteCustomer(db, req, previous)) {
      return {
        ok: false,
        customerId,
        customerName: String(previous?.name || ''),
        ownerUserId: resolveCustomerOwnerId(db, req.team.id, previous)
      };
    }
  }

  for (const [customerId, customer] of after) {
    if (before.has(customerId)) continue;
    const ownerId = resolveCustomerOwnerId(db, req.team.id, customer);
    if (ownerId && ownerId !== normalizedId(req.user.id) && !isAdmin(req)) {
      return { ok: false, customerId, customerName: String(customer?.name || ''), ownerUserId: ownerId };
    }
    if (!ownerId) {
      customer.created_by_user_id = req.user.id;
      if (customer.userId == null && customer.user_id == null) customer.userId = req.user.id;
      if (!String(customer.createdBy || '').trim()) customer.createdBy = req.user.display_name || req.user.username || '';
      if (!String(customer.created_by_username || '').trim()) customer.created_by_username = req.user.username || '';
    }
  }
  return { ok: true };
}

module.exports = {
  approvedCustomerPermission,
  canWriteCustomer,
  customerOwnerId,
  isAdmin,
  resolveCustomerOwnerId,
  validateWorkspaceCustomerChanges
};
