const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { addClient, publish, sendSse, createSyncEvent, operatorName, operatorUsername } = require('../services/syncHub');
const { notifyQueueAccepted, notifyQueueCompleted } = require('../services/syncQueueNotifications');
const { priorityMap, prioritySignature, isDeleted, isOfficial } = require('../services/priorityCustomers');
const { canWriteCustomer, validateWorkspaceCustomerChanges } = require('../services/dataPermissions');
const {
  captureOwnerId,
  mergeWorkspaceCapturesForUser,
  captureStableIdentityKeys,
  normalizeWorkspaceState,
  scopeWorkspaceStateForUser
} = require('../services/workspaceState');

const router = express.Router();
const MAX_EVENTS = 500;
const MAX_IMPORT_BATCH_ROWS = 500;
const MAX_SYNC_BATCH_BYTES = 1024 * 1024;
const CUSTOMER_EVIDENCE_DIR = path.resolve(__dirname, '..', '..', 'data', 'customer-evidence');
// Historical operator recovery is only needed for legacy customer rows. Keep
// the parsed result until either source table receives a new row for this team.
const historicalLibraryOperatorCache = new Map();

function requestId(req) {
  return String(req.get('X-Request-Id') || req.body?.requestId || crypto.randomUUID()).slice(0, 100);
}

function isTransientSyncError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return /^(SQLITE_(BUSY|LOCKED|IOERR|CANTOPEN))/.test(code)
    || /database is locked|database table is locked|sqlite_(busy|locked)|busy snapshot/.test(message);
}

function sendSyncFailure(res, error, message, requestIdValue) {
  const retryable = isTransientSyncError(error);
  console.error(`[sync] ${message}`, { requestId: requestIdValue, code: error?.code, error: error?.message });
  if (retryable) res.set('Retry-After', '3');
  return res.status(retryable ? 503 : 500).json({
    error: retryable ? `${message}，请稍后重试` : message,
    code: retryable ? 'SYNC_TEMPORARY_FAILURE' : 'SYNC_FAILURE',
    requestId: requestIdValue,
    retryable
  });
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function captureRecognitionKey(capture) {
  const isWechatChannel = capture?.platform === 'wechat-channel' || String(capture?.channel_account || '').trim() !== '';
  const platform = isWechatChannel ? 'wechat-channel' : 'douyin';
  const account = isWechatChannel ? capture?.channel_account : capture?.douyin_id;
  const value = String(account || '').trim().toLowerCase().replace(/[\s\u3000]+/g, '');
  return value ? `${platform}:${value}` : '';
}

function sameWorkspaceState(left, right) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

function petGuideConfigChanged(previousState, nextState) {
  const previous = previousState?.settings?.petGuideConfig;
  const next = nextState?.settings?.petGuideConfig;
  return JSON.stringify(previous ?? null) !== JSON.stringify(next ?? null);
}

function canManagePetGuideConfig(req) {
  return String(req?.user?.username || '').trim() === (process.env.DEMO_ADMIN_USERNAME || 'demo');
}

function applyObjectPatch(target, patch) {
  const result = { ...(target || {}) };
  Object.entries(patch || {}).forEach(([key, value]) => {
    if (value && value.__zxDelete) delete result[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)
      && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = applyObjectPatch(result[key], value);
    } else result[key] = value;
  });
  return result;
}

function parseTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function recordFieldTime(record, field) {
  return parseTime(record?.fieldUpdatedAt?.[field] || record?.field_updated_at?.[field])
    || parseTime(record?.updatedAt || record?.updated_at || record?.createdAt || record?.created_at);
}

function timestampedObjectPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const incomingMeta = patch.fieldUpdatedAt || patch.field_updated_at || {};
  const result = {};
  const acceptedMeta = {};
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'fieldUpdatedAt' || field === 'field_updated_at') continue;
    const incomingTime = parseTime(incomingMeta[field]) || parseTime(patch.updatedAt || patch.updated_at);
    const currentTime = recordFieldTime(current, field);
    if (incomingTime && currentTime && incomingTime < currentTime) continue;
    result[field] = value;
    if (incomingMeta[field]) acceptedMeta[field] = incomingMeta[field];
  }
  if (Object.keys(acceptedMeta).length) result.fieldUpdatedAt = acceptedMeta;
  return result;
}

function applyWorkspacePatch(base, patch) {
  const result = JSON.parse(JSON.stringify(base || {}));
  Object.entries(patch?.replace || {}).forEach(([key, value]) => {
    if (value && value.__zxDelete) delete result[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)
      && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = applyObjectPatch(result[key], value);
    } else result[key] = value;
  });
  Object.entries(patch?.arrays || {}).forEach(([key, change]) => {
    if (change?.replace !== undefined) {
      result[key] = JSON.parse(JSON.stringify(change.replace));
      return;
    }
    const list = Array.isArray(result[key]) ? result[key] : [];
    const map = new Map(list.map(item => [String(item?.id), item]));
    (change?.remove || []).forEach(entry => map.delete(String(typeof entry === 'object' ? entry.id : entry)));
    (change?.update || []).forEach(item => {
      const id = String(item?.id ?? '');
      if (id && map.has(id)) map.set(id, applyObjectPatch(map.get(id), item.fields));
    });
    (change?.add || []).forEach(item => {
      const id = String(item?.id ?? '');
      if (!id) return;
      if (map.has(id)) map.set(id, applyObjectPatch(map.get(id), timestampedObjectPatch(map.get(id), item)));
      else map.set(id, item);
    });
    result[key] = [...map.values()];
  });
  return normalizeWorkspaceState(result);
}

function buildWorkspaceDelta(base, next) {
  const previous = base || {};
  const current = next || {};
  const patch = { replace: {}, arrays: {} };
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of keys) {
    const before = previous[key];
    const after = current[key];
    if (Array.isArray(before) || Array.isArray(after)) {
      const oldList = Array.isArray(before) ? before : [];
      const newList = Array.isArray(after) ? after : [];
      const hasIds = [...oldList, ...newList].every(item => item && typeof item === 'object' && !Array.isArray(item) && item.id != null);
      if (!hasIds) {
        if (JSON.stringify(oldList) !== JSON.stringify(newList)) patch.arrays[key] = { replace: newList };
        continue;
      }
      const oldMap = new Map(oldList.map(item => [String(item.id), item]));
      const newMap = new Map(newList.map(item => [String(item.id), item]));
      const change = { add: [], update: [], remove: [] };
      for (const [id, item] of newMap) {
        if (!oldMap.has(id)) change.add.push(item);
        else if (JSON.stringify(oldMap.get(id)) !== JSON.stringify(item)) change.update.push({ id, fields: item });
      }
      for (const id of oldMap.keys()) if (!newMap.has(id)) change.remove.push(id);
      if (change.add.length || change.update.length || change.remove.length) patch.arrays[key] = change;
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) patch.replace[key] = after === undefined ? { __zxDelete: true } : after;
  }
  return patch;
}

function publicWorkspaceDelta(base, next, options = {}) {
  const privateArrayHints = Array.isArray(options.privateArrays) ? options.privateArrays : null;
  if (privateArrayHints) {
    // Captures are private to their owner. On ordinary customer edits they are
    // unchanged, so exclude them before building the public event delta.
    const previous = { ...(base || {}) };
    const current = { ...(next || {}) };
    delete previous.captures;
    delete current.captures;
    return {
      patch: buildWorkspaceDelta(previous, current),
      privateArrays: [...new Set(privateArrayHints.filter((key) => key === 'captures'))]
    };
  }
  const patch = buildWorkspaceDelta(base, next);
  const privateArrays = [];
  if (patch.arrays.captures) {
    privateArrays.push('captures');
    delete patch.arrays.captures;
  }
  return { patch, privateArrays };
}

function patchCanRebase(patch) {
  const hasReplace = Object.keys(patch?.replace || {}).length > 0;
  const arrayChanges = Object.values(patch?.arrays || {});
  const hasArrayChange = arrayChanges.some(change => change && (change.replace !== undefined || (change.add || []).length || (change.update || []).length || (change.remove || []).length));
  return (hasReplace || hasArrayChange) && !arrayChanges.some(change => change && change.replace !== undefined);
}

function preparePatchForCurrentState(patch, currentState) {
  const nextPatch = JSON.parse(JSON.stringify(patch || {}));
  const state = currentState || {};
  for (const [key, change] of Object.entries(nextPatch.arrays || {})) {
    const currentById = new Map((Array.isArray(state[key]) ? state[key] : []).map(item => [String(item?.id), item]));
    if (change?.update?.length) {
      change.update = change.update.map(item => {
        const current = currentById.get(String(item?.id));
        if (!current) return null;
        const fields = timestampedObjectPatch(current, item.fields || {});
        delete fields.syncVersion;
        return Object.keys(fields).length ? { id: item.id, fields } : null;
      }).filter(Boolean);
    }
    if (change?.remove?.length) {
      change.remove = change.remove.filter(entry => {
        const id = String(typeof entry === 'object' ? entry.id : entry);
        const current = currentById.get(id);
        if (!current || typeof entry !== 'object') return true;
        const incomingTime = parseTime(entry.deletedAt || entry.updatedAt);
        const currentTime = parseTime(current.updatedAt || current.updated_at || current.createdAt || current.created_at);
        return !incomingTime || !currentTime || incomingTime >= currentTime;
      });
    }
  }
  for (const [key, value] of Object.entries(nextPatch.replace || {})) {
    if (value?.__zxDelete) continue;
    const current = state[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
      && current && typeof current === 'object' && !Array.isArray(current)) {
      nextPatch.replace[key] = timestampedObjectPatch(current, value);
    }
  }
  return nextPatch;
}

function bumpCustomerSyncVersions(nextState, previousState) {
  const previousById = new Map((previousState.customers || []).map(customer => [String(customer.id), customer]));
  nextState.customers = (nextState.customers || []).map(customer => {
    const previous = previousById.get(String(customer.id));
    if (!previous) return { ...customer, syncVersion: Math.max(1, Number(customer.syncVersion || 0)) };
    const before = { ...previous };
    const after = { ...customer };
    delete before.syncVersion;
    delete after.syncVersion;
    if (JSON.stringify(before) === JSON.stringify(after)) return { ...customer, syncVersion: Number(previous.syncVersion || 0) };
    return { ...customer, syncVersion: Number(previous.syncVersion || 0) + 1 };
  });
  return nextState;
}

function syncCursor(db, teamId) {
  return Number(db.prepare('SELECT COALESCE(MAX(id), 0) cursor FROM sync_events WHERE team_id = ?').get(teamId).cursor || 0);
}

function importBatchResponse(db, req, row, replayed = false) {
  const skippedIds = parseJson(row.skipped_ids, []);
  const skipReasons = parseJson(row.skip_reasons, {});
  const duplicateSkippedIds = Array.isArray(skipReasons?.duplicate) ? skipReasons.duplicate : [];
  const permissionSkippedIds = Array.isArray(skipReasons?.permission) ? skipReasons.permission : [];
  const alreadyAbsentIds = Array.isArray(skipReasons?.alreadyAbsent) ? skipReasons.alreadyAbsent : [];
  const statusChangedIds = Array.isArray(skipReasons?.statusChanged) ? skipReasons.statusChanged : [];
  return {
    importId: row.import_id,
    batchIndex: Number(row.batch_index),
    totalBatches: Number(row.total_batches),
    accepted: Number(row.row_count || 0),
    skipped: Number(row.skipped_count || 0),
    skippedIds: Array.isArray(skippedIds) ? skippedIds : [],
    duplicateSkipped: duplicateSkippedIds.length,
    permissionSkipped: permissionSkippedIds.length,
    duplicateSkippedIds,
    permissionSkippedIds,
    alreadyAbsentIds,
    statusChangedIds,
    version: Number(row.version || 0),
    cursor: syncCursor(db, req.team.id),
    replayed
  };
}

function contactValues(value) {
  return String(value || '').split(/[\n,，;；|]/).map(item => item.trim().toLowerCase())
    .filter(item => item && !['-', '未填写', '未填写手机号', '未绑定'].includes(item))
    .filter(item => !/^(?:暂无|无|未知|不详|未提供|未获取|未找到|未确认)(?:公开)?(?:联系(?:方式)?|手机号|微信(?:号)?|抖音(?:号)?)?$/.test(item))
    .filter(item => !/(?:联系方式来源|公开搜索卡片|主页文本)/.test(item));
}

function customerHasContact(customer, field, value) {
  const wanted = new Set(contactValues(value));
  return contactValues(customer?.[field]).some(item => wanted.has(item));
}

function captureDuplicateMatches(candidate, customers) {
  const fields = [['phone', '手机号'], ['wechat_id', '微信号'], ['douyin_id', '抖音号']];
  return (customers || []).map(customer => {
    const matchedFields = [];
    fields.forEach(([key, label]) => {
      const matched = contactValues(candidate?.[key]).find(value => customerHasContact(customer, key, value));
      if (matched) matchedFields.push({ key, label, value: candidate?.[key] });
    });
    return matchedFields.length ? { customer, matchedFields } : null;
  }).filter(Boolean).sort((left, right) => right.matchedFields.length - left.matchedFields.length);
}

function eventRow(row) {
  const name = operatorName(getDatabase(), row.operator_user_id);
  return {
    id: Number(row.id), eventId: row.event_id, teamId: row.team_id,
    entityType: row.entity_type, entityId: row.entity_id, action: row.action,
    entityVersion: Number(row.entity_version || 0), operatorUserId: row.operator_user_id,
    operatorName: name, operatorUsername: operatorUsername(getDatabase(), row.operator_user_id),
    requestId: row.request_id, payload: parseJson(row.payload, {}), createdAt: row.created_at
  };
}

function stateRow(db, teamId) {
  return db.prepare('SELECT * FROM workspace_states WHERE team_id = ?').get(teamId);
}

function normalizeOperatorId(value) {
  const id = String(value ?? '').trim();
  return id || '';
}

function storedEventOrder(createdAt, id) {
  const raw = String(createdAt ?? '').trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const time = parseTime(normalized);
  return (time || 0) * 1000 + Number(id || 0);
}

function historicalLibraryOperators(db, teamId) {
  const version = db.prepare(`SELECT
    (SELECT COALESCE(MAX(id), 0) FROM sync_events WHERE team_id = ?) AS eventId,
    (SELECT COALESCE(MAX(id), 0) FROM operation_logs WHERE team_id = ?) AS logId`).get(teamId, teamId);
  const cacheKey = `${Number(version.eventId || 0)}:${Number(version.logId || 0)}`;
  const cached = historicalLibraryOperatorCache.get(String(teamId));
  if (cached?.cacheKey === cacheKey) return cached.operators;
  const operators = new Map();
  const remember = (customerId, operatorUserId, eventOrder) => {
    const id = String(customerId ?? '').trim();
    const operatorId = normalizeOperatorId(operatorUserId);
    if (!id || !operatorId) return;
    const previous = operators.get(id);
    if (!previous || eventOrder > previous.eventOrder) operators.set(id, { operatorId, eventOrder });
  };

  // Older versions did not persist the person who promoted a pending row.
  // The durable customer.status_changed event still contains the transition
  // from pending to official and its operator, so use that as the source of
  // truth for snapshots when the field is absent from the stored customer.
  const statusEvents = db.prepare(`SELECT id, entity_id, operator_user_id, payload, created_at
    FROM sync_events
    WHERE team_id = ? AND entity_type = 'customer' AND action = 'customer.status_changed'
    ORDER BY id ASC`).all(teamId);
  statusEvents.forEach((row) => {
    const payload = parseJson(row.payload, {});
    const before = payload?.delta?.before || {};
    const after = payload?.delta?.after || {};
    const beforeApproval = String(before.approval || before.approval_status || '');
    const afterApproval = String(after.approval || after.approval_status || '');
    if (beforeApproval !== '待确认' || afterApproval === '待确认') return;
    remember(row.entity_id || payload.customerId, row.operator_user_id, storedEventOrder(row.created_at, row.id));
  });

  // A few old batch-promotion records predate the per-customer transition
  // event. Keep those recoverable through the batch audit log as well.
  const promotionLogs = db.prepare(`SELECT id, operator_user_id, after_data, created_at
    FROM operation_logs
    WHERE team_id = ? AND action = 'customer.approved_batch'
    ORDER BY id ASC`).all(teamId);
  promotionLogs.forEach((row) => {
    const data = parseJson(row.after_data, {});
    (Array.isArray(data.acceptedIds) ? data.acceptedIds : []).forEach((customerId) => {
      remember(customerId, row.operator_user_id, storedEventOrder(row.created_at, row.id));
    });
  });
  historicalLibraryOperatorCache.set(String(teamId), { cacheKey, operators });
  return operators;
}

function attachHistoricalLibraryOperators(db, teamId, state) {
  if (!state || !Array.isArray(state.customers)) return state;
  const missing = state.customers.filter((customer) => {
    const approval = String(customer?.approval || customer?.approval_status || '正式');
    const existing = [customer?.joinedByUserId, customer?.joined_by_user_id,
      customer?.libraryJoinedByUserId, customer?.library_joined_by_user_id]
      .map(normalizeOperatorId).find(Boolean);
    return approval !== '待确认' && !existing;
  });
  if (!missing.length) return state;
  const operators = historicalLibraryOperators(db, teamId);
  if (!operators.size) return state;
  const users = new Map(db.prepare('SELECT id, username, display_name FROM users')
    .all().map((user) => [normalizeOperatorId(user.id), user]));
  let changed = false;
  const customers = state.customers.map((customer) => {
    const existing = [customer?.joinedByUserId, customer?.joined_by_user_id,
      customer?.libraryJoinedByUserId, customer?.library_joined_by_user_id]
      .map(normalizeOperatorId).find(Boolean);
    if (existing || String(customer?.approval || customer?.approval_status || '正式') === '待确认') return customer;
    const operator = operators.get(String(customer?.id ?? '').trim());
    if (!operator) return customer;
    const user = users.get(operator.operatorId);
    if (!user) return customer;
    changed = true;
    return {
      ...customer,
      joinedByUserId: /^\d+$/.test(operator.operatorId) ? Number(operator.operatorId) : operator.operatorId,
      joinedBy: user.display_name || user.username || '',
      joinedByUsername: user.username || ''
    };
  });
  return changed ? { ...state, customers } : state;
}

function publicSnapshot(db, req) {
  const row = stateRow(db, req.team.id);
  const cursor = db.prepare('SELECT COALESCE(MAX(id), 0) cursor FROM sync_events WHERE team_id = ?').get(req.team.id).cursor;
  const rawState = row && Number(row.version) > 0
    ? attachHistoricalLibraryOperators(db, req.team.id, normalizeWorkspaceState(parseJson(row.state_json, {}), { skipCaptureDedupe: true }))
    : null;
  return {
    team: { id: req.team.id, code: req.team.code, name: req.team.name, role: req.team.role },
    user: { id: req.user.id, username: req.user.username, display_name: req.user.display_name, role: req.user.role },
    initialized: Boolean(row && Number(row.version) > 0),
    version: Number(row?.version || 0),
    state: row && Number(row.version) > 0
      ? scopeWorkspaceStateForUser(hideIncompleteImportData(rawState), req.user, { skipCaptureDedupe: true })
      : null,
    cursor: Number(cursor || 0),
    serverTime: new Date().toISOString()
  };
}

// Import batches are committed to the shared state as they arrive so the
// existing idempotent endpoints and promotion flow keep working. Until the
// final batch is recorded, hide those marked records from every snapshot so
// other browsers cannot observe a partial import.
function hideIncompleteImportData(state) {
  const source = state && typeof state === 'object' ? state : {};
  return {
    ...source,
    customers: (Array.isArray(source.customers) ? source.customers : [])
      .filter(customer => !customer?._zxPendingImportId),
    captures: (Array.isArray(source.captures) ? source.captures : [])
      .filter(capture => !capture?._zxPendingImportId)
  };
}

function clearImportMarkers(state, importId) {
  const clean = value => {
    if (!value || value._zxPendingImportId !== importId) return value;
    const next = { ...value };
    delete next._zxPendingImportId;
    delete next._zxPendingImportOwnerId;
    return next;
  };
  return {
    ...state,
    customers: (state.customers || []).map(clean),
    captures: (state.captures || []).map(clean)
  };
}

function customerMap(state) {
  return new Map((Array.isArray(state?.customers) ? state.customers : []).map((item) => [String(item.id), item]));
}

function statusOf(customer) {
  return String(customer?.sales_status || customer?.status || '');
}

function appendPriorityEvents(nextState, previousState, req, requestIdValue, createdEvents, db, nextVersion) {
  const before = customerMap(previousState);
  const after = customerMap(nextState);
  const beforePriority = priorityMap(db, req.team.id, [...before.values()]);
  const afterPriority = priorityMap(db, req.team.id, [...after.values()]);
  for (const [customerId, customer] of after) {
    const previous = before.get(customerId);
    if (!previous) {
      const created = afterPriority.get(customerId);
      if (!created || !isOfficial(customer) || isDeleted(customer)) continue;
      const payload = { customerId, customerName: customer.name || '', reason: 'customer.created', after: created };
      const event = createSyncEvent(db, {
        teamId: req.team.id, entityType: 'customer', entityId: customerId,
        action: 'customer.priority_changed', entityVersion: nextVersion,
        operatorUserId: req.user.id, requestId: requestIdValue, payload
      });
      db.prepare(`INSERT INTO operation_logs
        (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'customer', ?, 'customer.priority_changed', ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, customerId, JSON.stringify(created), requestIdValue, req.ip || '', req.get('user-agent') || '');
      createdEvents.push(event);
      continue;
    }
    const previousScore = beforePriority.get(customerId);
    const nextScore = afterPriority.get(customerId);
    if (!previousScore || !nextScore) continue;
    const eligibilityChanged = isDeleted(previous) !== isDeleted(customer) || isOfficial(previous) !== isOfficial(customer);
    const changed = eligibilityChanged || prioritySignature(previousScore) !== prioritySignature(nextScore);
    if (!changed) continue;
    const payload = {
      customerId, customerName: customer.name || '',
      reason: eligibilityChanged ? 'customer.lifecycle_changed' : 'customer.priority_inputs_changed',
      before: previousScore, after: nextScore,
      beforeEligible: isOfficial(previous) && !isDeleted(previous),
      afterEligible: isOfficial(customer) && !isDeleted(customer)
    };
    const event = createSyncEvent(db, {
      teamId: req.team.id, entityType: 'customer', entityId: customerId,
      action: 'customer.priority_changed', entityVersion: nextVersion,
      operatorUserId: req.user.id, requestId: requestIdValue, payload
    });
    db.prepare(`INSERT INTO operation_logs
      (team_id, operator_user_id, entity_type, entity_id, action, before_data, after_data, request_id, ip_address, user_agent)
      VALUES (?, ?, 'customer', ?, 'customer.priority_changed', ?, ?, ?, ?, ?)`)
      .run(req.team.id, req.user.id, customerId, JSON.stringify(previousScore), JSON.stringify(nextScore), requestIdValue, req.ip || '', req.get('user-agent') || '');
    createdEvents.push(event);
  }
}

function appendServerStatusHistory(nextState, previousState, req, requestIdValue, createdEvents, db, nextVersion) {
  const before = customerMap(previousState);
  const after = customerMap(nextState);
  const operator = req.user.display_name || req.user.username || `用户${req.user.id}`;
  const timestamp = new Date().toISOString();

  for (const [customerId, customer] of after) {
    const previous = before.get(customerId);
    const fromStatus = statusOf(previous);
    const toStatus = statusOf(customer);

    const previousHistory = Array.isArray(previous?.statusHistory) ? previous.statusHistory : [];
    const incomingHistory = Array.isArray(customer.statusHistory) ? customer.statusHistory : [];
    const historyKeys = new Set(incomingHistory.map((item) => `${item?.requestId || ''}|${item?.from || ''}|${item?.to || ''}|${item?.at || ''}`));
    customer.statusHistory = [...previousHistory.filter((item) => {
      const key = `${item?.requestId || ''}|${item?.from || ''}|${item?.to || ''}|${item?.at || ''}`;
      if (historyKeys.has(key)) return false;
      historyKeys.add(key);
      return true;
    }), ...incomingHistory];

    if (fromStatus === toStatus || !toStatus) continue;

    const entry = {
      from: fromStatus,
      to: toStatus,
      at: timestamp,
      user: operator,
      operatorUserId: req.user.id,
      reason: previous ? '销售状态变更' : '客户创建时设置销售状态',
      source: 'web',
      requestId: requestIdValue
    };
    if (!Array.isArray(customer.statusHistory)) customer.statusHistory = [];
    const duplicated = customer.statusHistory.some((item) => item && item.requestId === requestIdValue && String(item.from || '') === fromStatus && String(item.to || '') === toStatus);
    if (!duplicated) customer.statusHistory.push(entry);

    const event = createSyncEvent(db, {
      teamId: req.team.id,
      entityType: 'customer',
      entityId: customerId,
      action: 'customer.status_changed',
      entityVersion: nextVersion,
      operatorUserId: req.user.id,
      requestId: requestIdValue,
      payload: { customerId, customerName: customer.name || '', fromStatus, toStatus, delta: { before: previous || null, after: customer } }
    });
    db.prepare(`INSERT OR IGNORE INTO workspace_customer_status_history
      (team_id, customer_id, user_id, operator_user_id, from_status, to_status, reason, source, request_id, sync_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'web', ?, ?)`)
      .run(req.team.id, customerId, req.user.id, req.user.id, fromStatus, toStatus, entry.reason, requestIdValue, event.eventId);
    createdEvents.push(event);
  }
}

router.get('/events', (req, res, next) => {
  if (!req.headers.authorization && req.query.token) req.headers.authorization = `Bearer ${req.query.token}`;
  next();
}, authRequired, resolveTeamContext, (req, res) => {
  const db = getDatabase();
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');

  const requestedCursor = Number(req.get('Last-Event-ID') || req.query.cursor || 0) || 0;
  // Register before replaying history. Otherwise a write between the history
  // query and addClient() is neither replayed nor delivered live.
  const remove = addClient(req.team.id, res, requestedCursor);
  const missed = db.prepare('SELECT * FROM sync_events WHERE team_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
    .all(req.team.id, requestedCursor, MAX_EVENTS);
  missed.forEach((row) => sendSse(res, { ...eventRow(row), replay: true }));

  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch (_) { clearInterval(heartbeat); remove(); }
  }, 15000);
  req.on('close', () => { clearInterval(heartbeat); remove(); });
});

router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);

router.get('/snapshot', (req, res) => {
  res.json(publicSnapshot(getDatabase(), req));
});

// The dashboard uses this query as the authoritative source for today's
// status-change card. The workspace snapshot is still used for the rest of
// the page, but a history query prevents a delayed or partial browser snapshot
// from hiding later status changes.
router.get('/status-history/today', (req, res) => {
  const requestedDate = String(req.query.date || '').trim();
  const db = getDatabase();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
    ? requestedDate
    : db.prepare("SELECT date('now', 'localtime') date").get().date;
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 5000)) : 2000;
  const where = `h.team_id = ? AND date(h.created_at, 'localtime') = date(?)`;
  const state = parseJson(stateRow(db, req.team.id)?.state_json, {});
  const officialCustomers = new Map((state.customers || [])
    .filter(customer => customer?.approval !== '待确认' && !isDeleted(customer))
    .map(customer => [String(customer.id), customer]));
  const rows = db.prepare(`SELECT h.id, h.customer_id, h.from_status, h.to_status,
      h.reason, h.source, h.request_id, h.created_at,
      h.operator_user_id, u.username operator_username, u.display_name operator_display_name
    FROM workspace_customer_status_history h
    LEFT JOIN users u ON u.id = h.operator_user_id
    WHERE ${where}
    ORDER BY h.created_at ASC, h.id ASC`).all(req.team.id, date);
  const timestamp = value => {
    const text = String(value || '').trim();
    if (!text) return 0;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? `${text.replace(' ', 'T')}Z`
      : text;
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const grouped = new Map();
  rows.forEach(row => {
    const customerId = String(row.customer_id);
    const customer = officialCustomers.get(customerId);
    const fromStatus = String(row.from_status || '').trim();
    const toStatus = String(row.to_status || '').trim();
    const eventTime = timestamp(row.created_at);
    const joinedTime = timestamp(customer?.joinedAt || customer?.joined_at || customer?.createdAt || customer?.created_at);
    if (!customer || !fromStatus || !toStatus || fromStatus === toStatus) return;
    if (joinedTime && eventTime + 1000 < joinedTime) return;
    if (row.reason === '客户创建时设置销售状态') return;
    if (!grouped.has(customerId)) grouped.set(customerId, []);
    grouped.get(customerId).push({ row, eventTime });
  });
  const records = [...grouped.values()].map(items => {
    items.sort((a, b) => a.eventTime - b.eventTime || Number(a.row.id) - Number(b.row.id));
    const first = items[0].row;
    const latest = items[items.length - 1].row;
    return {
      ...latest,
      first_from_status: first.from_status,
      latest_to_status: latest.to_status,
      first_created_at: first.created_at
    };
  }).sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at) || Number(b.id) - Number(a.id));
  res.json({ date, total: records.length, records: records.slice(0, limit) });
});

// Historical status changes are returned one row per transition. Unlike the
// dashboard's today card, this endpoint intentionally does not collapse a
// customer's multiple changes into one summary row.
router.get('/status-history/range', (req, res) => {
  const db = getDatabase();
  const from = new Date(String(req.query.from || ''));
  const to = new Date(String(req.query.to || ''));
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    return res.status(400).json({ error: '历史状态变更时间范围无效' });
  }
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 10000)) : 5000;
  const state = parseJson(stateRow(db, req.team.id)?.state_json, {});
  const officialCustomers = new Map((state.customers || [])
    .filter(customer => customer?.approval !== '待确认' && !isDeleted(customer))
    .map(customer => [String(customer.id), customer]));
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const rows = db.prepare(`SELECT h.id, h.customer_id, h.from_status, h.to_status,
      h.reason, h.source, h.request_id, h.created_at,
      h.operator_user_id, u.username operator_username, u.display_name operator_display_name
    FROM workspace_customer_status_history h
    LEFT JOIN users u ON u.id = h.operator_user_id
    WHERE h.team_id = ?
      AND datetime(h.created_at) >= datetime(?)
      AND datetime(h.created_at) < datetime(?)
    ORDER BY h.created_at DESC, h.id DESC
    LIMIT ?`).all(req.team.id, fromIso, toIso, limit);
  const parseTimestamp = value => {
    const text = String(value || '').trim();
    if (!text) return 0;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? `${text.replace(' ', 'T')}Z`
      : text;
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const isInWindow = value => {
    const timestamp = parseTimestamp(value);
    return timestamp >= from.getTime() && timestamp < to.getTime();
  };
  const records = [];
  const seen = new Set();
  const addRecord = (record, customer) => {
    const customerId = String(record.customer_id || record.customerId || '');
    const fromStatus = String(record.from_status || record.from || '').trim();
    const toStatus = String(record.to_status || record.to || '').trim();
    const createdAt = record.created_at || record.createdAt || record.at || '';
    const eventTime = parseTimestamp(createdAt);
    if (!customer || !customerId || !fromStatus || !toStatus || fromStatus === toStatus || !eventTime || !isInWindow(createdAt)) return;
    const joinedTime = parseTimestamp(customer.joinedAt || customer.joined_at || customer.createdAt || customer.created_at);
    if (joinedTime && eventTime + 1000 < joinedTime) return;
    if (record.reason === '客户创建时设置销售状态') return;
    const requestId = String(record.request_id || record.requestId || '').trim();
    const key = requestId
      ? `${customerId}|${requestId}|${fromStatus}|${toStatus}`
      : `${customerId}|${fromStatus}|${toStatus}|${Math.round(eventTime / 1000)}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({
      id: record.id || `legacy-${records.length + 1}`,
      customer_id: customerId,
      customer_name: customer.name || '未命名客户',
      from_status: fromStatus,
      to_status: toStatus,
      reason: record.reason || '销售状态变更',
      source: record.source || 'statusHistory',
      request_id: requestId,
      created_at: createdAt,
      operator_user_id: record.operator_user_id || record.operatorUserId || '',
      operator_username: record.operator_username || '',
      operator_display_name: record.operator_display_name || record.operatorDisplayName || record.user || ''
    });
  };
  rows.forEach(row => addRecord(row, officialCustomers.get(String(row.customer_id))));
  // Older records may only exist in the snapshot's statusHistory array.
  // Include them so the new view remains compatible with legacy workspaces.
  officialCustomers.forEach(customer => {
    (Array.isArray(customer.statusHistory) ? customer.statusHistory : []).forEach(item => {
      addRecord({
        ...item,
        customer_id: customer.id,
        created_at: item.at || item.createdAt || item.created_at,
        from_status: item.from || item.from_status,
        to_status: item.to || item.to_status,
        request_id: item.requestId || item.request_id,
        operator_user_id: item.operatorUserId || item.operator_user_id || item.userId || item.user_id,
        operator_display_name: item.operatorDisplayName || item.operator_display_name || item.user
      }, customer);
    });
  });
  records.sort((a, b) => parseTimestamp(b.created_at) - parseTimestamp(a.created_at) || Number(b.id || 0) - Number(a.id || 0));
  res.json({ from: fromIso, to: toIso, total: records.length, records: records.slice(0, limit) });
});

// Persist a copy of every client-side batch before the browser starts work.
// The server worker can finish these records after the browser is closed.
router.post('/queue', (req, res) => {
  const body = req.body || {};
  const queueId = String(body.queueId || '').trim();
  const operation = String(body.operation || '').trim();
  const batchIndex = Number(body.batchIndex);
  const totalBatches = Number(body.totalBatches);
  const priority = Math.max(0, Math.min(100, Number.isFinite(Number(body.priority)) ? Number(body.priority) : 40));
  const payload = body.payload;
  if (!queueId || queueId.length > 160) return res.status(400).json({ error: '后台任务编号无效' });
  if (!['patch', 'backup', 'import', 'directImport', 'safeReplacementPending', 'promote', 'capturePromote', 'delete', 'captureDelete', 'replace'].includes(operation)) return res.status(400).json({ error: '后台任务类型无效' });
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || !Number.isInteger(totalBatches) || totalBatches < 1 || batchIndex >= totalBatches) {
    return res.status(400).json({ error: '后台任务批次编号无效' });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return res.status(400).json({ error: '后台任务批次内容无效' });
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_SYNC_BATCH_BYTES) return res.status(413).json({ error: '后台任务批次超过 1MB，请继续拆分后重试', code: 'PAYLOAD_TOO_LARGE', retryable: false });

  const db = getDatabase();
  try {
    const result = db.transaction(() => {
      let job = db.prepare('SELECT * FROM sync_queue_jobs WHERE team_id = ? AND queue_id = ?').get(req.team.id, queueId);
      if (!job) {
        db.prepare(`INSERT INTO sync_queue_jobs
          (queue_id, team_id, user_id, operation, total_batches, priority, status, next_attempt_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)`)
          .run(queueId, req.team.id, req.user.id, operation, totalBatches, priority);
        job = db.prepare('SELECT * FROM sync_queue_jobs WHERE team_id = ? AND queue_id = ?').get(req.team.id, queueId);
      } else if (job.user_id !== req.user.id || job.operation !== operation || Number(job.total_batches) !== totalBatches) {
        return { conflict: true };
      }
      const existing = db.prepare('SELECT payload_json, status FROM sync_queue_batches WHERE job_id = ? AND batch_index = ?').get(job.id, batchIndex);
      if (existing) {
        if (existing.payload_json !== JSON.stringify(payload)) return { conflict: true };
        return { jobId: job.id, batchIndex, registered: false, status: existing.status };
      }
      db.prepare(`INSERT INTO sync_queue_batches
        (job_id, batch_index, total_batches, payload_json, status, next_attempt_at)
        VALUES (?, ?, ?, ?, 'pending', NULL)`)
        .run(job.id, batchIndex, totalBatches, JSON.stringify(payload));
      return { jobId: job.id, batchIndex, registered: true, status: 'pending' };
    })();
    if (result.conflict) return res.status(409).json({ error: '后台任务编号已对应其他同步内容' });
    return res.status(202).json({ queueId, batchIndex, totalBatches, registered: result.registered, status: result.status });
  } catch (error) {
    return sendSyncFailure(res, error, '后台同步任务保存失败', requestId(req));
  }
});

function queueJobStatus(db, job) {
  const batches = db.prepare(`SELECT batch_index, status, attempts, last_error, response_json
    FROM sync_queue_batches WHERE job_id = ? ORDER BY batch_index`).all(job.id);
  let accepted = 0;
  let skipped = 0;
  let duplicateSkipped = 0;
  let permissionSkipped = 0;
  let restoredFiles = 0;
  let remappedUserReferences = null;
  const skippedIds = [];
  const duplicateSkippedIds = [];
  const permissionSkippedIds = [];
  const acceptedCaptureIds = [];
  const duplicateTargetIds = {};
  const alreadyAbsentIds = [];
  const statusChangedIds = [];
  const replacedRowKeys = [];
  const conflictRowKeys = [];
  const replacementPermissionRowKeys = [];
  const changedCustomerIds = [];
  for (const batch of batches) {
    const response = parseJson(batch.response_json, {}) || {};
    restoredFiles += Number(response.restoredFiles || 0);
    if (response.remappedUserReferences) remappedUserReferences = response.remappedUserReferences;
    if (job.operation === 'directImport') {
      accepted += Number(response.promoted?.accepted || 0);
      skipped += Number(response.promoted?.skipped || 0);
      duplicateSkipped += Number(response.promoted?.duplicateSkipped || 0);
      permissionSkipped += Number(response.promoted?.permissionSkipped || 0);
      skippedIds.push(...(Array.isArray(response.promoted?.skippedIds) ? response.promoted.skippedIds : []));
      duplicateSkippedIds.push(...(Array.isArray(response.promoted?.duplicateSkippedIds) ? response.promoted.duplicateSkippedIds : []));
      permissionSkippedIds.push(...(Array.isArray(response.promoted?.permissionSkippedIds) ? response.promoted.permissionSkippedIds : []));
      alreadyAbsentIds.push(...(Array.isArray(response.promoted?.alreadyAbsentIds) ? response.promoted.alreadyAbsentIds : []));
      statusChangedIds.push(...(Array.isArray(response.promoted?.statusChangedIds) ? response.promoted.statusChangedIds : []));
    } else if (job.operation === 'capturePromote') {
      acceptedCaptureIds.push(...(Array.isArray(response.acceptedCaptureIds) ? response.acceptedCaptureIds : []));
      Object.assign(duplicateTargetIds, response.duplicateTargetIds && typeof response.duplicateTargetIds === 'object' ? response.duplicateTargetIds : {});
      accepted += Number(response.accepted || 0);
      skipped += Number(response.skipped || 0);
      duplicateSkipped += Number(response.duplicateSkipped || 0);
      permissionSkipped += Number(response.permissionSkipped || 0);
      skippedIds.push(...(Array.isArray(response.skippedIds) ? response.skippedIds : []));
      duplicateSkippedIds.push(...(Array.isArray(response.duplicateSkippedIds) ? response.duplicateSkippedIds : []));
      permissionSkippedIds.push(...(Array.isArray(response.permissionSkippedIds) ? response.permissionSkippedIds : []));
      alreadyAbsentIds.push(...(Array.isArray(response.alreadyAbsentIds) ? response.alreadyAbsentIds : []));
    } else {
      accepted += Number(response.accepted || 0);
      skipped += Number(response.skipped || 0);
      duplicateSkipped += Number(response.duplicateSkipped || 0);
      permissionSkipped += Number(response.permissionSkipped || 0);
      skippedIds.push(...(Array.isArray(response.skippedIds) ? response.skippedIds : []));
      duplicateSkippedIds.push(...(Array.isArray(response.duplicateSkippedIds) ? response.duplicateSkippedIds : []));
      permissionSkippedIds.push(...(Array.isArray(response.permissionSkippedIds) ? response.permissionSkippedIds : []));
      alreadyAbsentIds.push(...(Array.isArray(response.alreadyAbsentIds) ? response.alreadyAbsentIds : []));
      statusChangedIds.push(...(Array.isArray(response.statusChangedIds) ? response.statusChangedIds : []));
      replacedRowKeys.push(...(Array.isArray(response.replacedRowKeys) ? response.replacedRowKeys : []));
      conflictRowKeys.push(...(Array.isArray(response.conflictRowKeys) ? response.conflictRowKeys : []));
      replacementPermissionRowKeys.push(...(Array.isArray(response.permissionRowKeys) ? response.permissionRowKeys : []));
      changedCustomerIds.push(...(Array.isArray(response.changedCustomerIds) ? response.changedCustomerIds : []));
    }
  }
  return {
    jobId: job.queue_id,
    operation: job.operation,
    status: job.status,
    totalBatches: Number(job.total_batches || 0),
    completedBatches: batches.filter(batch => batch.status === 'completed').length,
    retryingBatches: batches.filter(batch => batch.status === 'retrying').length,
    failedBatches: batches.filter(batch => batch.status === 'failed').length,
    accepted,
    skipped,
    duplicateSkipped,
    permissionSkipped,
    restoredFiles,
    remappedUserReferences,
    skippedIds: [...new Set(skippedIds.map(String))],
    duplicateSkippedIds: [...new Set(duplicateSkippedIds.map(String))],
    permissionSkippedIds: [...new Set(permissionSkippedIds.map(String))],
    acceptedCaptureIds: [...new Set(acceptedCaptureIds.map(String))],
    duplicateTargetIds,
    alreadyAbsentIds: [...new Set(alreadyAbsentIds.map(String))],
    statusChangedIds: [...new Set(statusChangedIds.map(String))],
    replacedRowKeys: [...new Set(replacedRowKeys.map(String))],
    conflictRowKeys: [...new Set(conflictRowKeys.map(String))],
    replacementPermissionRowKeys: [...new Set(replacementPermissionRowKeys.map(String))],
    changedCustomerIds: [...new Set(changedCustomerIds.map(String))],
    attempts: Number(job.attempts || 0),
    lastError: job.last_error || '',
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at
  };
}

// Register a complete browser operation in one transaction. Once this returns
// 202, the browser may close and the server worker still owns every batch.
router.post('/jobs', (req, res) => {
  const body = req.body || {};
  const queueId = String(body.jobId || body.queueId || '').trim();
  const operation = String(body.operation || '').trim();
  const batches = Array.isArray(body.batches) ? body.batches : [];
  const priority = Math.max(0, Math.min(100, Number.isFinite(Number(body.priority)) ? Number(body.priority) : 40));
  if (!queueId || queueId.length > 160) return res.status(400).json({ error: '后台任务编号无效' });
  if (!['patch', 'backup', 'import', 'directImport', 'safeReplacementPending', 'promote', 'capturePromote', 'delete', 'captureDelete', 'replace'].includes(operation)) return res.status(400).json({ error: '后台任务类型无效' });
  if (!batches.length || batches.length > 500) return res.status(400).json({ error: '后台任务必须包含 1-500 个内部批次' });
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    if (Number(batch?.batchIndex) !== index || !batch?.payload || typeof batch.payload !== 'object' || Array.isArray(batch.payload)) {
      return res.status(400).json({ error: `后台任务第 ${index + 1} 个批次格式无效` });
    }
    if (Buffer.byteLength(JSON.stringify(batch.payload), 'utf8') > MAX_SYNC_BATCH_BYTES) {
      return res.status(413).json({ error: `后台任务第 ${index + 1} 个批次超过 1MB`, code: 'PAYLOAD_TOO_LARGE', retryable: false });
    }
  }

  const db = getDatabase();
  let job;
  let created = false;
  try {
    db.transaction(() => {
      job = db.prepare('SELECT * FROM sync_queue_jobs WHERE team_id = ? AND queue_id = ?').get(req.team.id, queueId);
      if (job) {
        if (job.user_id !== req.user.id || job.operation !== operation || Number(job.total_batches) !== batches.length) {
          throw Object.assign(new Error('后台任务编号已对应其他同步内容'), { status: 409 });
        }
        return;
      }
      db.prepare(`INSERT INTO sync_queue_jobs
        (queue_id, team_id, user_id, operation, total_batches, priority, status, next_attempt_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)`)
        .run(queueId, req.team.id, req.user.id, operation, batches.length, priority);
      job = db.prepare('SELECT * FROM sync_queue_jobs WHERE team_id = ? AND queue_id = ?').get(req.team.id, queueId);
      const insert = db.prepare(`INSERT INTO sync_queue_batches
        (job_id, batch_index, total_batches, payload_json, status, next_attempt_at)
        VALUES (?, ?, ?, ?, 'pending', NULL)`);
      batches.forEach((batch, index) => insert.run(job.id, index, batches.length, JSON.stringify(batch.payload)));
      created = true;
    })();
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ error: error.message });
    return sendSyncFailure(res, error, '后台任务创建失败', requestId(req));
  }
  if (created) notifyQueueAccepted(db, job);
  res.status(202).json({ ...queueJobStatus(db, job), created });
});

// A reopened browser may not have its IndexedDB queue record yet. Expose the
// initiating user's active jobs so the client can restore progress from the
// durable server queue without receiving batch payloads.
router.get('/jobs', (req, res) => {
  const db = getDatabase();
  const jobs = db.prepare(`SELECT * FROM sync_queue_jobs
    WHERE team_id = ? AND user_id = ? AND status IN ('pending', 'running', 'retrying', 'failed')
    ORDER BY id DESC LIMIT 50`).all(req.team.id, req.user.id);
  res.json({ jobs: jobs.map(job => queueJobStatus(db, job)) });
});

router.get('/jobs/:jobId', (req, res) => {
  const db = getDatabase();
  const job = db.prepare('SELECT * FROM sync_queue_jobs WHERE team_id = ? AND queue_id = ? AND user_id = ?')
    .get(req.team.id, String(req.params.jobId || ''), req.user.id);
  if (!job) return res.status(404).json({ error: '后台任务不存在或已清理' });
  res.json(queueJobStatus(db, job));
});

router.post('/jobs/:jobId/retry', (req, res) => {
  const db = getDatabase();
  const job = db.prepare('SELECT * FROM sync_queue_jobs WHERE team_id = ? AND queue_id = ? AND user_id = ?')
    .get(req.team.id, String(req.params.jobId || ''), req.user.id);
  if (!job) return res.status(404).json({ error: '后台任务不存在或已清理' });
  if (job.status !== 'failed') return res.status(409).json({ error: '只有最终失败的后台任务可以重试' });
  if (job.operation === 'fullBackupRestore') return res.status(409).json({ error: '失败的完整备份文件已安全清理，请重新选择备份文件导入' });
  db.transaction(() => {
    db.prepare(`UPDATE sync_queue_jobs SET status = 'pending', next_attempt_at = NULL, last_error = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(job.id);
    db.prepare(`UPDATE sync_queue_batches SET status = 'pending', next_attempt_at = NULL, last_error = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status = 'failed'`).run(job.id);
  })();
  const updated = db.prepare('SELECT * FROM sync_queue_jobs WHERE id = ?').get(job.id);
  notifyQueueAccepted(db, updated);
  res.status(202).json(queueJobStatus(db, updated));
});

router.post('/queue/complete', (req, res) => {
  const queueId = String(req.body?.queueId || '').trim();
  if (!queueId) return res.status(400).json({ error: '缺少后台任务编号' });
  const db = getDatabase();
  const job = db.prepare('SELECT * FROM sync_queue_jobs WHERE team_id = ? AND queue_id = ? AND user_id = ?')
    .get(req.team.id, queueId, req.user.id);
  // Completion is a cleanup operation. The worker or retention cleanup may
  // have already finalized or removed the record, so repeating it is safe.
  if (!job) return res.json({ queueId, status: 'completed', missing: true });
  const result = db.prepare(`UPDATE sync_queue_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP WHERE team_id = ? AND queue_id = ? AND user_id = ?`)
    .run(req.team.id, queueId, req.user.id);
  if (result.changes && job.status !== 'completed') notifyQueueCompleted(db, { ...job, status: 'completed' });
  res.json({ queueId, status: 'completed' });
});

function patchBatchRoute(action) {
  return (req, res) => {
    const body = req.body || {};
    const operationId = String(body.operationId || '').trim();
    const batchIndex = Number(body.batchIndex);
    const totalBatches = Number(body.totalBatches);
    const baseVersion = Number(body.baseVersion);
    const patch = body.patch;
    const rid = requestId(req);
    if (!operationId || operationId.length > 120) return res.status(400).json({ error: '同步任务编号无效' });
    if (!Number.isInteger(batchIndex) || batchIndex < 0 || !Number.isInteger(totalBatches) || totalBatches < 1 || batchIndex >= totalBatches) {
      return res.status(400).json({ error: '同步批次编号无效' });
    }
    if (!Number.isInteger(baseVersion) || baseVersion < 0) return res.status(400).json({ error: '缺少有效的数据版本号' });
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: '同步增量格式不正确' });
    if (Buffer.byteLength(JSON.stringify(patch), 'utf8') > MAX_SYNC_BATCH_BYTES) return res.status(413).json({ error: '同步批次超过 1MB，请继续拆分后重试', code: 'PAYLOAD_TOO_LARGE', retryable: false });

    const db = getDatabase();
    const cached = db.prepare('SELECT response_json FROM idempotency_requests WHERE team_id = ? AND request_id = ?')
      .get(req.team.id, rid);
    if (cached?.response_json) return res.json(parseJson(cached.response_json, {}));

    const events = [];
    let outcome;
    try {
      outcome = db.transaction(() => {
        const current = stateRow(db, req.team.id);
        const currentVersion = Number(current?.version || 0);
        if (!current || currentVersion <= 0) return { notInitialized: true };
        const previousState = normalizeWorkspaceState(parseJson(current.state_json, {}));
        if (currentVersion !== baseVersion && !patchCanRebase(patch)) return { conflict: true };
        const preparedPatch = preparePatchForCurrentState(patch, previousState);
        const patchedState = applyWorkspacePatch(previousState, preparedPatch);
        const captureChange = preparedPatch.arrays?.captures;
        const removedCaptureIds = captureChange?.replace !== undefined
          ? (previousState.captures || [])
            .filter(capture => !(Array.isArray(captureChange.replace) ? captureChange.replace : [])
              .some(item => String(item?.id ?? '') === String(capture?.id ?? '')))
            .map(capture => capture.id)
          : (Array.isArray(captureChange?.remove) ? captureChange.remove : [])
            .map(entry => typeof entry === 'object' ? entry.id : entry);
        const nextState = captureChange
          ? mergeWorkspaceCapturesForUser(previousState, patchedState, req.user, {
            preserveOmitted: true,
            removedCaptureIds
          })
          : patchedState;
        if (petGuideConfigChanged(previousState, nextState) && !canManagePetGuideConfig(req)) {
          return { petGuideDenied: true };
        }
        const permission = validateWorkspaceCustomerChanges(db, req, previousState, nextState);
        if (!permission.ok) return { denied: permission };
        const serializedNextState = JSON.stringify(nextState);
        if (JSON.stringify(previousState) === serializedNextState) return { unchanged: true, version: currentVersion };
        const nextVersion = currentVersion + 1;
        bumpCustomerSyncVersions(nextState, previousState);
        appendServerStatusHistory(nextState, previousState, req, rid, events, db, nextVersion);
        appendPriorityEvents(nextState, previousState, req, rid, events, db, nextVersion);
        db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, initialized_by_user_id = COALESCE(initialized_by_user_id, ?), updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
          .run(serializedNextState, nextVersion, req.user.id, req.user.id, req.team.id);
        const delta = publicWorkspaceDelta(previousState, nextState, {
          privateArrays: captureChange ? ['captures'] : []
        });
        const workspaceEvent = createSyncEvent(db, {
          teamId: req.team.id, entityType: 'workspace', entityId: String(req.team.id), action: 'workspace.updated',
          entityVersion: nextVersion, operatorUserId: req.user.id, requestId: rid,
          payload: { source: action, operationId, batchIndex, totalBatches, patch: delta.patch, privateArrays: delta.privateArrays }
        });
        events.push(workspaceEvent);
        db.prepare(`INSERT INTO operation_logs (team_id, operator_user_id, entity_type, entity_id, action, before_data, after_data, request_id, ip_address, user_agent)
          VALUES (?, ?, 'workspace', ?, ?, ?, ?, ?, ?, ?)`)
          .run(req.team.id, req.user.id, String(req.team.id), action, JSON.stringify({ version: currentVersion }), JSON.stringify({ version: nextVersion }), rid, req.ip || '', req.get('user-agent') || '');
        return { version: nextVersion };
      })();
    } catch (error) {
      return sendSyncFailure(res, error, action === 'backup_merge_batch' ? '备份导入批次写入失败' : '后台同步批次写入失败', rid);
    }
    if (outcome.notInitialized) return res.status(409).json({ error: '团队同步尚未初始化，请刷新页面后重试' });
    if (outcome.conflict) return res.status(409).json({ error: '团队数据已被其他成员更新', ...publicSnapshot(db, req) });
    if (outcome.petGuideDenied) return res.status(403).json({ error: '只有演示管理员 demo 可以配置桌宠' });
    if (outcome.denied) return res.status(403).json({
      error: `您没有编辑客户“${outcome.denied.customerName || '未命名客户'}”的权限，请先向创建人申请`,
      code: 'CUSTOMER_PERMISSION_REQUIRED', customerId: outcome.denied.customerId,
      customerName: outcome.denied.customerName, ownerUserId: outcome.denied.ownerUserId, ...publicSnapshot(db, req)
    });
    const response = {
      operationId, batchIndex, totalBatches, accepted: true,
      version: Number(outcome.version || 0), cursor: syncCursor(db, req.team.id), replayed: false
    };
    db.prepare('INSERT OR IGNORE INTO idempotency_requests (team_id, user_id, request_id, response_json) VALUES (?, ?, ?, ?)')
      .run(req.team.id, req.user.id, rid, JSON.stringify(response));
    events.forEach(event => publish(req.team.id, event));
    res.json(response);
  };
}

router.post('/patch-batch', patchBatchRoute('sync_patch_batch'));
router.post('/backup-merge-batch', patchBatchRoute('backup_merge_batch'));

// Paste recognition must reach the authoritative workspace before a refresh
// can replace the browser's optimistic rows with a server snapshot. This
// endpoint only appends or updates private capture rows for the signed-in user.
router.post('/upsert-captures', (req, res) => {
  const rawCaptures = Array.isArray(req.body?.captures) ? req.body.captures : [];
  const rid = requestId(req);
  if (!rawCaptures.length || rawCaptures.length > MAX_IMPORT_BATCH_ROWS) {
    return res.status(400).json({ error: `每次识别必须包含 1-${MAX_IMPORT_BATCH_ROWS} 条采集记录` });
  }
  if (rawCaptures.some(capture => !capture || typeof capture !== 'object' || Array.isArray(capture))) {
    return res.status(400).json({ error: '采集记录格式不正确' });
  }
  if (Buffer.byteLength(JSON.stringify(rawCaptures), 'utf8') > MAX_SYNC_BATCH_BYTES) {
    return res.status(413).json({ error: '本次识别数据超过 1MB，请分批粘贴后重试', code: 'PAYLOAD_TOO_LARGE', retryable: false });
  }

  const ownerName = req.user.display_name || req.user.username || '';
  const capturedAt = new Date().toISOString();
  const captures = rawCaptures.map((capture) => ({
    ...capture,
    id: String(capture.id || '').trim(),
    created_by_user_id: req.user.id,
    createdBy: ownerName,
    created_by_username: req.user.username || '',
    createdAt: capture.createdAt || capturedAt,
    updatedAt: capture.updatedAt || capture.createdAt || capturedAt
  }));
  if (captures.some(capture => !capture.id || capture.id.length > 160)) {
    return res.status(400).json({ error: '采集记录编号无效，请重新识别后再试' });
  }

  const db = getDatabase();
  const cached = db.prepare('SELECT response_json FROM idempotency_requests WHERE team_id = ? AND request_id = ?')
    .get(req.team.id, rid);
  if (cached?.response_json) {
    const response = parseJson(cached.response_json, null);
    if (response?.source === 'capture_upsert') return res.json({ ...response, replayed: true });
  }

  const publishedEvents = [];
  let outcome;
  try {
    outcome = db.transaction(() => {
      const current = stateRow(db, req.team.id);
      const currentVersion = Number(current?.version || 0);
      if (!current || currentVersion <= 0) return { notInitialized: true };

      const previousState = normalizeWorkspaceState(parseJson(current.state_json, {}), { skipCaptureDedupe: true });
      const recognitionKeys = new Set(
        previousState.captures
          .filter(capture => captureOwnerId(capture) === String(req.user.id))
          .map(captureRecognitionKey)
          .filter(Boolean)
      );
      const batchKeys = new Set();
      const promotedCaptureIds = new Set((previousState.capturePromotionTombstones || []).map(item => String(item?.id ?? item?.captureId ?? item).trim()).filter(Boolean));
      const promotedIdentityKeys = new Set((previousState.capturePromotionTombstones || [])
        .filter(item => String(item?.ownerId ?? item?.promotedByUserId ?? '') === String(req.user.id))
        .flatMap(item => Array.isArray(item?.identityKeys) ? item.identityKeys : [])
        .map(key => String(key || '').trim().toLowerCase())
        .filter(Boolean));
      const acceptedCaptures = [];
      const duplicateSkippedIds = [];
      captures.forEach((capture) => {
        const stableKeys = captureStableIdentityKeys(capture);
        if (promotedCaptureIds.has(String(capture.id)) || stableKeys.some(key => promotedIdentityKeys.has(key))) {
          duplicateSkippedIds.push(capture.id);
          return;
        }
        const key = captureRecognitionKey(capture);
        if (key && (recognitionKeys.has(key) || batchKeys.has(key))) {
          duplicateSkippedIds.push(capture.id);
          return;
        }
        if (key) batchKeys.add(key);
        acceptedCaptures.push(capture);
      });

      // Recognition is append-only: an existing platform account keeps its
      // original capture row and a repeated result is ignored entirely.
      const nextState = {
        ...previousState,
        captures: [...(previousState.captures || []), ...acceptedCaptures]
      };
      const scopedCaptures = nextState.captures
        .filter(capture => captureOwnerId(capture) === String(req.user.id));
      if (sameWorkspaceState(previousState, nextState)) {
        return {
          version: currentVersion,
          captures: scopedCaptures,
          changed: false,
          accepted: 0,
          duplicateSkippedIds
        };
      }

      const nextVersion = currentVersion + 1;
      db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
        .run(JSON.stringify(nextState), nextVersion, req.user.id, req.team.id);
      const delta = publicWorkspaceDelta(previousState, nextState);
      publishedEvents.push(createSyncEvent(db, {
        teamId: req.team.id,
        entityType: 'workspace',
        entityId: String(req.team.id),
        action: 'workspace.updated',
        entityVersion: nextVersion,
        operatorUserId: req.user.id,
        requestId: rid,
        payload: {
          source: 'capture_upsert',
          rowCount: acceptedCaptures.length,
          patch: delta.patch,
          privateArrays: delta.privateArrays
        }
      }));
      db.prepare(`INSERT INTO operation_logs (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'workspace', ?, 'capture_upsert', ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify({ rowCount: acceptedCaptures.length }), rid, req.ip || '', req.get('user-agent') || '');
      return {
        version: nextVersion,
        captures: scopedCaptures,
        changed: true,
        accepted: acceptedCaptures.length,
        duplicateSkippedIds
      };
    })();
  } catch (error) {
    return sendSyncFailure(res, error, '粘贴识别客户保存失败', rid);
  }

  if (outcome.notInitialized) return res.status(409).json({ error: '团队同步尚未初始化，请刷新页面后重试' });
  const response = {
    source: 'capture_upsert',
    accepted: Number(outcome.accepted || 0),
    duplicateSkipped: Array.isArray(outcome.duplicateSkippedIds) ? outcome.duplicateSkippedIds.length : 0,
    duplicateSkippedIds: outcome.duplicateSkippedIds || [],
    captureCount: outcome.captures.length,
    captures: outcome.captures,
    version: outcome.version,
    cursor: syncCursor(db, req.team.id),
    replayed: false
  };
  db.prepare('INSERT OR IGNORE INTO idempotency_requests (team_id, user_id, request_id, response_json) VALUES (?, ?, ?, ?)')
    .run(req.team.id, req.user.id, rid, JSON.stringify(response));
  publishedEvents.forEach(event => publish(req.team.id, event));
  res.status(outcome.changed ? 201 : 200).json(response);
});

// Large customer imports use append-only batches instead of sending the full
// workspace snapshot back through PUT /state. Each batch is idempotent and
// updates the workspace in one short transaction, so a lost response can be
// retried without creating duplicate customers.
router.post('/import-batch', (req, res) => {
  const body = req.body || {};
  const importId = String(body.importId || '').trim();
  const batchIndex = Number(body.batchIndex);
  const totalBatches = Number(body.totalBatches);
  const customers = Array.isArray(body.customers) ? body.customers : [];
  const captures = Array.isArray(body.captures) ? body.captures : [];
  const captureMode = String(body.captureMode || '').trim();
  // Excel customer imports explicitly opt out of capture creation. Older
  // internal callers without this marker retain their legacy behavior.
  const importCaptures = captureMode === 'none' ? [] : captures;
  const auditLog = body.auditLog && typeof body.auditLog === 'object' && !Array.isArray(body.auditLog)
    ? body.auditLog : null;

  if (!importId || importId.length > 120) return res.status(400).json({ error: '导入任务编号无效' });
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || !Number.isInteger(totalBatches) || totalBatches < 1 || batchIndex >= totalBatches) {
    return res.status(400).json({ error: '导入批次编号无效' });
  }
  if (!customers.length || customers.length > MAX_IMPORT_BATCH_ROWS) {
    return res.status(400).json({ error: `每批必须包含 1-${MAX_IMPORT_BATCH_ROWS} 条客户数据` });
  }
  if (importCaptures.length && importCaptures.length !== customers.length) return res.status(400).json({ error: '客户和采集记录数量不一致' });
  if (Buffer.byteLength(JSON.stringify({ customers, captures, captureMode, auditLog }), 'utf8') > MAX_SYNC_BATCH_BYTES) {
    return res.status(413).json({ error: '导入批次超过 1MB，请减少每批条数或字段内容', code: 'PAYLOAD_TOO_LARGE', retryable: false });
  }

  const db = getDatabase();
  const existingBatch = db.prepare(`SELECT import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version
    FROM workspace_import_batches WHERE team_id = ? AND import_id = ? AND batch_index = ?`)
    .get(req.team.id, importId, batchIndex);
  if (existingBatch) return res.json(importBatchResponse(db, req, existingBatch, true));

  const requestIdValue = requestId(req);
  const events = [];
  let result;
  try {
    result = db.transaction(() => {
      const current = stateRow(db, req.team.id);
      const currentVersion = Number(current?.version || 0);
      if (!current || currentVersion <= 0) return { notInitialized: true };

      const previousState = normalizeWorkspaceState(parseJson(current.state_json, {}));
      const existingCustomerIds = new Set((previousState.customers || []).map(item => String(item?.id ?? '')).filter(Boolean));
      const existingCaptureIds = new Set((previousState.captures || []).map(item => String(item?.id ?? '')).filter(Boolean));
      const addedCustomers = [];
      const addedCaptures = [];
      const seenCustomerIds = new Set();
      const seenCaptureIds = new Set();

      for (let index = 0; index < customers.length; index += 1) {
        const source = customers[index];
        const customerId = String(source?.id ?? '').trim();
        const capture = importCaptures[index];
        const captureId = String(capture?.id ?? '').trim();
        if (!source || typeof source !== 'object' || Array.isArray(source) || !customerId) {
          return { invalid: `第 ${index + 1} 条导入数据缺少唯一编号` };
        }
        if (!String(source.name || '').trim() || !String(source.province || '').trim() || !String(source.sales_status || '').trim()) {
          return { invalid: `第 ${index + 1} 条导入数据缺少姓名、省份或销售状态` };
        }
        if (seenCustomerIds.has(customerId) || existingCustomerIds.has(customerId)) continue;
        if (captureId && (seenCaptureIds.has(captureId) || existingCaptureIds.has(captureId))) return { invalid: `第 ${index + 1} 条采集记录编号重复` };
        seenCustomerIds.add(customerId);
        if (captureId) seenCaptureIds.add(captureId);
        const addedCustomer = { ...source };
        // A direct import is itself an operation that places the row in the
        // customer library. Pending imports intentionally wait for
        // /promote-batch before recording the library operator.
        if (addedCustomer.approval !== '待确认') {
          addedCustomer.joinedByUserId = req.user.id;
          addedCustomer.joinedBy = req.user.display_name || req.user.username || '';
          addedCustomer.joinedByUsername = req.user.username || '';
        }
        addedCustomers.push(addedCustomer);
        if (captureId) {
          addedCaptures.push({
            ...capture,
            created_by_user_id: req.user.id,
            createdBy: req.user.display_name || req.user.username || '',
            created_by_username: req.user.username || ''
          });
        }
      }

      const nextVersion = currentVersion + 1;
      const importState = { customers: addedCustomers, captures: addedCaptures };
      appendServerStatusHistory(importState, {}, req, requestIdValue, events, db, nextVersion);
      appendPriorityEvents(importState, {}, req, requestIdValue, events, db, nextVersion);
      const nextState = {
        ...previousState,
        customers: [...addedCustomers, ...(previousState.customers || [])],
        captures: [...addedCaptures, ...(previousState.captures || [])]
      };
      if (auditLog && batchIndex === totalBatches - 1) {
        nextState.logs = [auditLog, ...(Array.isArray(previousState.logs) ? previousState.logs : [])].slice(0, 300);
      }
      bumpCustomerSyncVersions(nextState, previousState);

      db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, initialized_by_user_id = COALESCE(initialized_by_user_id, ?), updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
        .run(JSON.stringify(nextState), nextVersion, req.user.id, req.user.id, req.team.id);
      const delta = publicWorkspaceDelta(previousState, nextState);
      const workspaceEvent = createSyncEvent(db, {
        teamId: req.team.id,
        entityType: 'workspace',
        entityId: String(req.team.id),
        action: 'workspace.updated',
        entityVersion: nextVersion,
        operatorUserId: req.user.id,
        requestId: requestIdValue,
        payload: { source: 'customer_import', importId, batchIndex, totalBatches, rowCount: addedCustomers.length, patch: delta.patch, privateArrays: delta.privateArrays }
      });
      events.push(workspaceEvent);
      db.prepare(`INSERT INTO operation_logs (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'workspace', ?, 'customer_import_batch', ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify({ importId, batchIndex, totalBatches, rowCount: addedCustomers.length }), requestIdValue, req.ip || '', req.get('user-agent') || '');
      db.prepare(`INSERT INTO workspace_import_batches
        (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, version, request_id, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, 0, '[]', ?, ?, ?)`)
        .run(req.team.id, importId, batchIndex, totalBatches, addedCustomers.length, nextVersion, requestIdValue, req.user.id);
      const completedBatches = Number(db.prepare(`SELECT COUNT(*) count FROM workspace_import_batches
        WHERE team_id = ? AND import_id = ? AND total_batches = ?`).get(req.team.id, importId, totalBatches).count || 0);
      if (completedBatches >= totalBatches) {
        events.push(createSyncEvent(db, {
          teamId: req.team.id,
          entityType: 'workspace',
          entityId: String(req.team.id),
          action: 'workspace.import.completed',
          entityVersion: nextVersion,
          operatorUserId: req.user.id,
          requestId: requestIdValue,
          payload: { source: 'customer_import', importId, totalBatches, rowCount: nextState.customers.length }
        }));
      }
      return { version: nextVersion, accepted: addedCustomers.length };
    })();
  } catch (error) {
    return sendSyncFailure(res, error, '客户导入批次写入失败', requestIdValue);
  }

  if (result.notInitialized) return res.status(409).json({ error: '团队同步尚未初始化，请刷新页面后重试' });
  if (result.invalid) return res.status(400).json({ error: result.invalid });
  events.forEach(event => publish(req.team.id, event));
  res.status(201).json({
    importId,
    batchIndex,
    totalBatches,
    accepted: result.accepted,
    skipped: 0,
    skippedIds: [],
    version: result.version,
    cursor: syncCursor(db, req.team.id),
    replayed: false
  });
});

// Save rows that were classified as safe replacements as new pending
// customers. The matched official customers are only used for a fresh safety
// and permission check; this route never updates or replaces them.
router.post('/safe-replacement-pending-batch', (req, res) => {
  const body = req.body || {};
  const importId = String(body.importId || '').trim();
  const batchIndex = Number(body.batchIndex);
  const totalBatches = Number(body.totalBatches);
  const customers = Array.isArray(body.customers) ? body.customers : [];
  const targetCustomerIds = Array.isArray(body.targetCustomerIds) ? body.targetCustomerIds.map(value => String(value || '')) : [];
  const auditLog = body.auditLog && typeof body.auditLog === 'object' && !Array.isArray(body.auditLog) ? body.auditLog : null;

  if (!importId || importId.length > 120) return res.status(400).json({ error: '可安全替换客户任务编号无效' });
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || !Number.isInteger(totalBatches) || totalBatches < 1 || batchIndex >= totalBatches) {
    return res.status(400).json({ error: '可安全替换客户批次编号无效' });
  }
  if (!customers.length || customers.length > MAX_IMPORT_BATCH_ROWS) {
    return res.status(400).json({ error: `每批必须包含 1-${MAX_IMPORT_BATCH_ROWS} 条客户数据` });
  }
  if (targetCustomerIds.length !== customers.length) {
    return res.status(400).json({ error: '客户和原客户匹配信息数量不一致' });
  }
  if (Buffer.byteLength(JSON.stringify({ customers, targetCustomerIds, auditLog }), 'utf8') > MAX_SYNC_BATCH_BYTES) {
    return res.status(413).json({ error: '可安全替换客户批次超过 1MB，请减少每批条数或字段内容', code: 'PAYLOAD_TOO_LARGE', retryable: false });
  }

  const db = getDatabase();
  const existingBatch = db.prepare(`SELECT import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version
    FROM workspace_import_batches WHERE team_id = ? AND import_id = ? AND batch_index = ?`)
    .get(req.team.id, importId, batchIndex);
  if (existingBatch) return res.json(importBatchResponse(db, req, existingBatch, true));

  const requestIdValue = requestId(req);
  const events = [];
  let result;
  try {
    result = db.transaction(() => {
      const current = stateRow(db, req.team.id);
      const currentVersion = Number(current?.version || 0);
      if (!current || currentVersion <= 0) return { notInitialized: true };

      const previousState = normalizeWorkspaceState(parseJson(current.state_json, {}));
      const official = (previousState.customers || []).filter(customer => customer?.approval !== '待确认');
      const officialById = new Map(official.map(customer => [String(customer.id), customer]));
      const pending = (previousState.customers || []).filter(customer => customer?.approval === '待确认');
      const existingCustomerIds = new Set((previousState.customers || []).map(customer => String(customer?.id || '')).filter(Boolean));
      const contactFields = ['phone', 'wechat_id', 'douyin_id'];
      const pendingContacts = Object.fromEntries(contactFields.map(field => [field, new Set(pending.flatMap(customer => contactValues(customer?.[field]))) ]));
      const acceptedContacts = Object.fromEntries(contactFields.map(field => [field, new Set()]));
      const acceptedTargets = new Set();
      const addedCustomers = [];
      const duplicateIds = [];
      const invalidIds = [];
      const conflictIds = [];
      const permissionIds = [];

      customers.forEach((source, index) => {
        const customerId = String(source?.id || '').trim();
        const targetId = targetCustomerIds[index];
        const skip = list => { if (customerId) list.push(customerId); else list.push(`row-${index + 1}`); };
        if (!source || typeof source !== 'object' || Array.isArray(source) || !customerId
          || !String(source.name || '').trim() || !String(source.province || '').trim() || !String(source.sales_status || '').trim()
          || existingCustomerIds.has(customerId)) {
          skip(invalidIds);
          return;
        }

        const matches = new Set();
        contactFields.forEach(field => contactValues(source[field]).forEach(value => {
          official.forEach(customer => { if (customerHasContact(customer, field, value)) matches.add(String(customer.id)); });
        }));
        if (matches.size !== 1 || !targetId || !matches.has(targetId) || acceptedTargets.has(targetId) || !officialById.has(targetId)) {
          skip(conflictIds);
          return;
        }
        if (!canWriteCustomer(db, req, officialById.get(targetId))) {
          skip(permissionIds);
          return;
        }
        const isPendingDuplicate = contactFields.some(field => contactValues(source[field])
          .some(value => pendingContacts[field].has(value) || acceptedContacts[field].has(value)));
        if (isPendingDuplicate) {
          skip(duplicateIds);
          return;
        }

        const timestamp = new Date().toISOString();
        const customer = {
          ...source,
          source: '批量导入',
          approval: '待确认',
          userId: req.user.id,
          createdBy: req.user.display_name || req.user.username || '',
          created_by_user_id: req.user.id,
          created_by_username: req.user.username || '',
          createdAt: source.createdAt || timestamp,
          updatedAt: timestamp
        };
        acceptedTargets.add(targetId);
        existingCustomerIds.add(customerId);
        contactFields.forEach(field => contactValues(customer[field]).forEach(value => acceptedContacts[field].add(value)));
        addedCustomers.push(customer);
      });

      const skippedIds = [...duplicateIds, ...invalidIds, ...conflictIds, ...permissionIds];
      const nextVersion = addedCustomers.length ? currentVersion + 1 : currentVersion;
      if (addedCustomers.length) {
        const nextState = {
          ...previousState,
          customers: [...addedCustomers, ...(previousState.customers || [])],
          captures: [...(previousState.captures || [])]
        };
        if (auditLog && batchIndex === totalBatches - 1) {
          nextState.logs = [auditLog, ...(Array.isArray(previousState.logs) ? previousState.logs : [])].slice(0, 300);
        }
        bumpCustomerSyncVersions(nextState, previousState);
        appendServerStatusHistory(nextState, previousState, req, requestIdValue, events, db, nextVersion);
        appendPriorityEvents(nextState, previousState, req, requestIdValue, events, db, nextVersion);
        db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, initialized_by_user_id = COALESCE(initialized_by_user_id, ?), updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
          .run(JSON.stringify(nextState), nextVersion, req.user.id, req.user.id, req.team.id);
        const delta = publicWorkspaceDelta(previousState, nextState);
        events.push(createSyncEvent(db, {
          teamId: req.team.id, entityType: 'workspace', entityId: String(req.team.id), action: 'workspace.updated',
          entityVersion: nextVersion, operatorUserId: req.user.id, requestId: requestIdValue,
          payload: { source: 'safe_replacement_pending_import', importId, batchIndex, totalBatches, rowCount: addedCustomers.length, patch: delta.patch, privateArrays: delta.privateArrays }
        }));
      }
      db.prepare(`INSERT INTO workspace_import_batches
        (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version, request_id, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.team.id, importId, batchIndex, totalBatches, addedCustomers.length, skippedIds.length,
          JSON.stringify(skippedIds), JSON.stringify({ duplicate: duplicateIds, invalid: invalidIds, conflict: conflictIds, permission: permissionIds }),
          nextVersion, requestIdValue, req.user.id);
      db.prepare(`INSERT INTO operation_logs
        (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'workspace', ?, 'customer.safe_replacement_pending_batch', ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify({ importId, batchIndex, totalBatches, accepted: addedCustomers.length, skipped: skippedIds.length }), requestIdValue, req.ip || '', req.get('user-agent') || '');
      return { version: nextVersion, accepted: addedCustomers.length };
    })();
  } catch (error) {
    return sendSyncFailure(res, error, '可安全替换客户加入待确认客户失败', requestIdValue);
  }

  if (result.notInitialized) return res.status(409).json({ error: '团队同步尚未初始化，请刷新页面后重试' });
  const stored = db.prepare(`SELECT import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version
    FROM workspace_import_batches WHERE team_id = ? AND import_id = ? AND batch_index = ?`)
    .get(req.team.id, importId, batchIndex);
  events.forEach(event => publish(req.team.id, event));
  res.status(201).json(importBatchResponse(db, req, stored, false));
});

const IMPORT_REPLACE_FIELDS = [
  'name', 'province', 'city', 'sales_status', 'phone', 'identity', 'qq', 'org_name',
  'wechat_nickname', 'wechat_id', 'managed_wechat_accounts', 'managed_wechat_account', 'douyin_nickname',
  'douyin_id', 'douyin_profile_url', 'douyin_followers', 'channel_account',
  'official_account', 'address', 'remark', 'moments_orders',
  'moments_orders_qualified', 'qrCodes'
];

function importReplacementValuePresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// The server re-checks matching and permissions inside the transaction so a
// stale browser preview can never replace a different official customer.
router.post('/replace-duplicate-batch', (req, res) => {
  const body = req.body || {};
  const importId = String(body.importId || '').trim();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!importId || importId.length > 120) return res.status(400).json({ error: '批量替换任务编号无效' });
  if (!items.length || items.length > MAX_IMPORT_BATCH_ROWS) {
    return res.status(400).json({ error: `每批必须包含 1-${MAX_IMPORT_BATCH_ROWS} 条替换数据` });
  }
  if (Buffer.byteLength(JSON.stringify(items), 'utf8') > MAX_SYNC_BATCH_BYTES) {
    return res.status(413).json({ error: '批量替换数据超过 1MB，请减少每批条数后重试', code: 'PAYLOAD_TOO_LARGE', retryable: false });
  }

  const db = getDatabase();
  const rid = requestId(req);
  const cached = db.prepare('SELECT response_json FROM idempotency_requests WHERE team_id = ? AND request_id = ?')
    .get(req.team.id, rid);
  if (cached?.response_json) return res.json({ ...parseJson(cached.response_json, {}), replayed: true });

  const publishedEvents = [];
  let result;
  try {
    result = db.transaction(() => {
      const current = stateRow(db, req.team.id);
      const currentVersion = Number(current?.version || 0);
      if (!current || currentVersion <= 0) return { notInitialized: true };
      const previousState = normalizeWorkspaceState(parseJson(current.state_json, {}));
      const official = (previousState.customers || []).filter(customer => customer?.approval !== '待确认');
      const officialById = new Map(official.map(customer => [String(customer.id), customer]));
      const contactFields = ['phone', 'wechat_id', 'douyin_id'];
      const normalizedItems = items.map((item, index) => ({
        rowKey: String(item?.rowKey || `row-${index + 1}`),
        targetCustomerId: String(item?.targetCustomerId || ''),
        data: item?.data && typeof item.data === 'object' && !Array.isArray(item.data) ? item.data : {}
      }));
      const analyses = normalizedItems.map(item => {
        const matches = new Set();
        contactFields.forEach(field => {
          contactValues(item.data[field]).forEach(value => {
            official.forEach(customer => {
              if (customerHasContact(customer, field, value)) matches.add(String(customer.id));
            });
          });
        });
        const targetId = matches.size === 1 ? [...matches][0] : '';
        return { ...item, matches: [...matches], targetId };
      });
      const targetCounts = new Map();
      analyses.forEach(item => {
        if (item.targetId) targetCounts.set(item.targetId, (targetCounts.get(item.targetId) || 0) + 1);
      });

      const conflictRowKeys = [];
      const permissionRowKeys = [];
      const replacedRowKeys = [];
      const changedCustomerIds = [];
      const replacements = new Map();
      const timestamp = new Date().toISOString();
      analyses.forEach(item => {
        if (item.matches.length !== 1 || item.targetId !== item.targetCustomerId || targetCounts.get(item.targetId) !== 1) {
          conflictRowKeys.push(item.rowKey);
          return;
        }
        const target = officialById.get(item.targetId);
        if (!target) {
          conflictRowKeys.push(item.rowKey);
          return;
        }
        if (!canWriteCustomer(db, req, target)) {
          permissionRowKeys.push(item.rowKey);
          return;
        }
        const next = { ...target };
        const fieldUpdatedAt = { ...(target.fieldUpdatedAt || target.field_updated_at || {}) };
        let changed = false;
        IMPORT_REPLACE_FIELDS.forEach(field => {
          const value = item.data[field];
          if (!importReplacementValuePresent(value)) return;
          if (JSON.stringify(next[field] ?? null) === JSON.stringify(value ?? null)) return;
          next[field] = value;
          fieldUpdatedAt[field] = timestamp;
          changed = true;
        });
        if (importReplacementValuePresent(item.data.managed_wechat_account)
          || importReplacementValuePresent(item.data.managed_wechat_accounts)) {
          const accountValues = Array.isArray(item.data.managed_wechat_accounts)
            ? item.data.managed_wechat_accounts
            : [item.data.managed_wechat_account];
          const normalizedAccounts = [...new Set(accountValues.map(value => String(value || '').trim()).filter(Boolean))];
          if (JSON.stringify(next.managed_wechat_accounts || []) !== JSON.stringify(normalizedAccounts)
            || String(next.managed_wechat_account || '') !== String(normalizedAccounts[0] || '')) {
            next.managed_wechat_accounts = normalizedAccounts;
            next.managed_wechat_account = normalizedAccounts[0] || '';
            fieldUpdatedAt.managed_wechat_accounts = timestamp;
            fieldUpdatedAt.managed_wechat_account = timestamp;
            changed = true;
          }
        }
        if (changed) {
          next.fieldUpdatedAt = fieldUpdatedAt;
          next.updatedAt = timestamp;
          replacements.set(item.targetId, next);
          changedCustomerIds.push(item.targetId);
        }
        replacedRowKeys.push(item.rowKey);
      });

      if (!replacements.size) {
        return { version: currentVersion, replacedRowKeys, conflictRowKeys, permissionRowKeys, changedCustomerIds: [] };
      }
      const nextState = {
        ...previousState,
        customers: (previousState.customers || []).map(customer => replacements.get(String(customer.id)) || customer)
      };
      const nextVersion = currentVersion + 1;
      bumpCustomerSyncVersions(nextState, previousState);
      appendServerStatusHistory(nextState, previousState, req, rid, publishedEvents, db, nextVersion);
      appendPriorityEvents(nextState, previousState, req, rid, publishedEvents, db, nextVersion);
      db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
        .run(JSON.stringify(nextState), nextVersion, req.user.id, req.team.id);
      const delta = publicWorkspaceDelta(previousState, nextState);
      publishedEvents.push(createSyncEvent(db, {
        teamId: req.team.id, entityType: 'workspace', entityId: String(req.team.id),
        action: 'workspace.updated', entityVersion: nextVersion, operatorUserId: req.user.id,
        requestId: rid, payload: {
          source: 'customer_import_replace', importId, replacedCount: replacedRowKeys.length,
          customerIds: changedCustomerIds, patch: delta.patch, privateArrays: delta.privateArrays
        }
      }));
      changedCustomerIds.forEach(customerId => {
        const before = officialById.get(customerId);
        const after = replacements.get(customerId);
        publishedEvents.push(createSyncEvent(db, {
          teamId: req.team.id, entityType: 'customer', entityId: customerId,
          action: 'customer.updated', entityVersion: nextVersion, operatorUserId: req.user.id,
          requestId: rid, payload: { customerId, customerName: after?.name || '', delta: { before, after } }
        }));
      });
      db.prepare(`INSERT INTO operation_logs
        (team_id, operator_user_id, entity_type, entity_id, action, before_data, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'workspace', ?, 'customer.import_replaced_batch', ?, ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify({ importId }),
          JSON.stringify({ importId, replacedRowKeys, conflictRowKeys, permissionRowKeys, changedCustomerIds }),
          rid, req.ip || '', req.get('user-agent') || '');
      return { version: nextVersion, replacedRowKeys, conflictRowKeys, permissionRowKeys, changedCustomerIds };
    })();
  } catch (error) {
    return sendSyncFailure(res, error, '批量替换客户失败', rid);
  }
  if (result.notInitialized) return res.status(409).json({ error: '团队同步尚未初始化，请刷新页面后重试' });
  const response = {
    importId,
    replaced: result.replacedRowKeys.length,
    replacedRowKeys: result.replacedRowKeys,
    conflict: result.conflictRowKeys.length,
    conflictRowKeys: result.conflictRowKeys,
    permission: result.permissionRowKeys.length,
    permissionRowKeys: result.permissionRowKeys,
    changedCustomerIds: result.changedCustomerIds,
    version: result.version,
    cursor: syncCursor(db, req.team.id),
    replayed: false
  };
  db.prepare('INSERT OR IGNORE INTO idempotency_requests (team_id, user_id, request_id, response_json) VALUES (?, ?, ?, ?)')
    .run(req.team.id, req.user.id, rid, JSON.stringify(response));
  publishedEvents.forEach(event => publish(req.team.id, event));
  res.status(201).json(response);
});

// Promote selected pending customers in small, idempotent batches. Duplicate
// checks are performed against the current official customer set on the server
// so two browser tabs cannot bypass the rule at the same time.
router.post('/promote-batch', (req, res) => {
  const body = req.body || {};
  const importId = String(body.importId || '').trim();
  const batchIndex = Number(body.batchIndex);
  const totalBatches = Number(body.totalBatches);
  const customerIds = Array.isArray(body.customerIds) ? [...new Set(body.customerIds.map(id => String(id).trim()).filter(Boolean))] : [];
  const customerPayloads = Array.isArray(body.customers) ? body.customers : [];
  if (!importId || importId.length > 120) return res.status(400).json({ error: '批量加入任务编号无效' });
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || !Number.isInteger(totalBatches) || totalBatches < 1 || batchIndex >= totalBatches) {
    return res.status(400).json({ error: '批量加入批次编号无效' });
  }
  if (customerIds.length > MAX_IMPORT_BATCH_ROWS) {
    return res.status(400).json({ error: `每批最多包含 ${MAX_IMPORT_BATCH_ROWS} 位客户` });
  }
  if (customerPayloads.length > MAX_IMPORT_BATCH_ROWS) {
    return res.status(400).json({ error: `每批最多包含 ${MAX_IMPORT_BATCH_ROWS} 位客户数据` });
  }

  const db = getDatabase();
  const existingBatch = db.prepare(`SELECT import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version
    FROM workspace_import_batches WHERE team_id = ? AND import_id = ? AND batch_index = ?`)
    .get(req.team.id, importId, batchIndex);
  if (existingBatch) return res.json(importBatchResponse(db, req, existingBatch, true));

  const requestIdValue = requestId(req);
  const publishedEvents = [];
  let result;
  try {
    result = db.transaction(() => {
      const current = stateRow(db, req.team.id);
      const currentVersion = Number(current?.version || 0);
      if (!current || currentVersion <= 0) return { notInitialized: true };
      const previousState = normalizeWorkspaceState(parseJson(current.state_json, {}));
      if (!customerIds.length) {
        db.prepare(`INSERT INTO workspace_import_batches
          (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version, request_id, created_by_user_id)
          VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`)
          .run(req.team.id, importId, batchIndex, totalBatches, JSON.stringify([]), JSON.stringify({ duplicate: [], permission: [] }), currentVersion, requestIdValue, req.user.id);
        return { version: currentVersion, accepted: 0, acceptedIds: [], skipped: 0, skippedIds: [], duplicateSkippedIds: [], permissionSkippedIds: [] };
      }
      const selected = new Set(customerIds);
      const payloadById = new Map(customerPayloads
        .filter(customer => customer && typeof customer === 'object' && !Array.isArray(customer))
        .map(customer => [String(customer.id || '').trim(), customer])
        .filter(([customerId]) => customerId));
      const contactFields = ['phone', 'wechat_id', 'douyin_id'];
      const skippedIds = [];
      const duplicateSkippedIds = [];
      const permissionSkippedIds = [];
      const acceptedIds = [];
      const acceptedContacts = { phone: new Map(), wechat_id: new Map(), douyin_id: new Map() };
      const promotedAt = new Date().toISOString();
      const existingCustomerIds = new Set((previousState.customers || []).map(customer => String(customer?.id)));
      const recoveredCustomers = customerIds
        .filter(customerId => !existingCustomerIds.has(customerId))
        .map(customerId => {
          const source = payloadById.get(customerId);
          if (!source || !String(source.name || '').trim() || !String(source.province || '').trim() || !String(source.sales_status || '').trim()) {
            skippedIds.push(customerId);
            duplicateSkippedIds.push(customerId);
            return null;
          }
          const recovered = { ...source, id: customerId, approval: '待确认' };
          delete recovered._zxPendingImportId;
          delete recovered._zxPendingImportOwnerId;
          return recovered;
        })
        .filter(Boolean);
      const workingCustomers = [...recoveredCustomers, ...(previousState.customers || [])];
      const official = workingCustomers.filter(customer => customer?.approval !== '待确认');
      const duplicateTargetId = customer => {
        for (const field of contactFields) {
          for (const value of contactValues(customer[field])) {
            const existing = official.find(item => customerHasContact(item, field, value));
            if (existing) return String(existing.id);
            const acceptedId = acceptedContacts[field].get(value);
            if (acceptedId) return acceptedId;
          }
        }
        return '';
      };
      const nextCustomers = workingCustomers.map(customer => {
        if (!selected.has(String(customer?.id))) return customer;
        if (customer.approval !== '待确认') {
          skippedIds.push(String(customer.id));
          duplicateSkippedIds.push(String(customer.id));
          return customer;
        }
        const targetId = duplicateTargetId(customer);
        if (targetId) {
          const customerId = String(customer.id);
          skippedIds.push(customerId);
          duplicateSkippedIds.push(customerId);
          return customer;
        }
        if (!canWriteCustomer(db, req, customer)) {
          const customerId = String(customer.id);
          skippedIds.push(customerId);
          permissionSkippedIds.push(customerId);
          return customer;
        }
        acceptedIds.push(String(customer.id));
        contactFields.forEach(field => {
          contactValues(customer[field]).forEach(value => acceptedContacts[field].set(value, String(customer.id)));
        });
        return {
          ...customer,
          approval: '正式',
          joinedAt: promotedAt,
          joinedByUserId: req.user.id,
          joinedBy: req.user.display_name || req.user.username || '',
          joinedByUsername: req.user.username || '',
          createdAt: promotedAt,
          updatedAt: promotedAt
        };
      }).filter(Boolean);
      const acceptedSet = new Set(acceptedIds);
      const nextState = {
        ...previousState,
        customers: nextCustomers,
        captures: (previousState.captures || []).filter(capture =>
          !acceptedSet.has(String(capture?.customerId ?? capture?.customer_id ?? '')))
      };
      if (!acceptedIds.length && !skippedIds.length) return { invalid: '未找到可加入客户库的待确认客户' };
      if (!acceptedIds.length) {
        db.prepare(`INSERT INTO workspace_import_batches
          (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version, request_id, created_by_user_id)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
          .run(req.team.id, importId, batchIndex, totalBatches, skippedIds.length, JSON.stringify(skippedIds), JSON.stringify({ duplicate: duplicateSkippedIds, permission: permissionSkippedIds }), currentVersion, requestIdValue, req.user.id);
        return { version: currentVersion, accepted: 0, acceptedIds: [], skipped: skippedIds.length, skippedIds, duplicateSkippedIds, permissionSkippedIds };
      }
      const nextVersion = currentVersion + 1;
      bumpCustomerSyncVersions(nextState, previousState);
      appendPriorityEvents(nextState, previousState, req, requestIdValue, publishedEvents, db, nextVersion);
      acceptedIds.forEach(customerId => {
        const customer = nextState.customers.find(item => String(item.id) === customerId);
        const event = createSyncEvent(db, {
          teamId: req.team.id,
          entityType: 'customer',
          entityId: customerId,
          action: 'customer.approved',
          entityVersion: nextVersion,
          operatorUserId: req.user.id,
          requestId: requestIdValue,
          payload: { customerId, customerName: customer?.name || '' }
        });
        publishedEvents.push(event);
      });
      acceptedIds.forEach(customerId => {
        publishedEvents.push(createSyncEvent(db, {
          teamId: req.team.id,
          entityType: 'customer',
          entityId: customerId,
          action: 'customer.capture_confirmed',
          entityVersion: nextVersion,
          operatorUserId: req.user.id,
          requestId: requestIdValue,
          payload: { customerId, source: 'pending_customer_promote' }
        }));
      });
      db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
        .run(JSON.stringify(nextState), nextVersion, req.user.id, req.team.id);
      const delta = publicWorkspaceDelta(previousState, nextState);
      const workspaceEvent = createSyncEvent(db, {
        teamId: req.team.id,
        entityType: 'workspace',
        entityId: String(req.team.id),
        action: 'workspace.updated',
        entityVersion: nextVersion,
        operatorUserId: req.user.id,
        requestId: requestIdValue,
        payload: { source: 'pending_customer_promote', importId, batchIndex, totalBatches, rowCount: acceptedIds.length, promotedCount: acceptedIds.length, skippedCount: skippedIds.length, duplicateSkippedCount: duplicateSkippedIds.length, permissionSkippedCount: permissionSkippedIds.length, patch: delta.patch, privateArrays: delta.privateArrays }
      });
      publishedEvents.push(workspaceEvent);
      db.prepare(`INSERT INTO operation_logs (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'customer', ?, 'customer.approved_batch', ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify({ importId, batchIndex, totalBatches, acceptedIds, promotedIds: acceptedIds, skippedIds, duplicateSkippedIds, permissionSkippedIds }), requestIdValue, req.ip || '', req.get('user-agent') || '');
      db.prepare(`INSERT INTO workspace_import_batches
        (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version, request_id, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.team.id, importId, batchIndex, totalBatches, acceptedIds.length, skippedIds.length, JSON.stringify(skippedIds), JSON.stringify({ duplicate: duplicateSkippedIds, permission: permissionSkippedIds }), nextVersion, requestIdValue, req.user.id);
      return { version: nextVersion, accepted: acceptedIds.length, acceptedIds, skipped: skippedIds.length, skippedIds, duplicateSkippedIds, permissionSkippedIds };
    })();
  } catch (error) {
    return sendSyncFailure(res, error, '批量加入客户库失败', requestIdValue);
  }
  if (result.notInitialized) return res.status(409).json({ error: '团队同步尚未初始化，请刷新页面后重试' });
  if (result.invalid) return res.status(400).json({ error: result.invalid });
  if (result.denied) return res.status(403).json({
    error: `您没有编辑客户“${result.denied.customerName || '未命名客户'}”的权限，请先向创建人申请`,
    code: 'CUSTOMER_PERMISSION_REQUIRED',
    customerId: result.denied.customerId,
    customerName: result.denied.customerName,
    ownerUserId: result.denied.ownerUserId
  });
  publishedEvents.forEach(event => publish(req.team.id, event));
  res.status(201).json({
    importId,
    batchIndex,
    totalBatches,
    accepted: result.accepted,
    acceptedIds: result.acceptedIds,
    skipped: result.skipped,
    skippedIds: result.skippedIds,
    duplicateSkippedIds: result.duplicateSkippedIds,
    permissionSkippedIds: result.permissionSkippedIds,
    duplicateSkipped: result.duplicateSkippedIds.length,
    permissionSkipped: result.permissionSkippedIds.length,
    version: result.version,
    cursor: syncCursor(db, req.team.id),
    replayed: false
  });
});

// Promote capture records directly into the official customer library. The
// capture stays in place when duplicate or permission checks reject it, so a
// user can compare or edit it before trying again.
router.post('/promote-capture-batch', (req, res) => {
  const body = req.body || {};
  const importId = String(body.importId || '').trim();
  const batchIndex = Number(body.batchIndex);
  const totalBatches = Number(body.totalBatches);
  const captureIds = Array.isArray(body.captureIds)
    ? [...new Set(body.captureIds.map(id => String(id).trim()).filter(Boolean))]
    : [];
  const capturePayloads = Array.isArray(body.captures) ? body.captures : [];
  if (!importId || importId.length > 120) return res.status(400).json({ error: '批量转入客户库任务编号无效' });
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || !Number.isInteger(totalBatches) || totalBatches < 1 || batchIndex >= totalBatches) {
    return res.status(400).json({ error: '批量转入客户库批次编号无效' });
  }
  if (!captureIds.length || captureIds.length > MAX_IMPORT_BATCH_ROWS) {
    return res.status(400).json({ error: `每批必须包含 1-${MAX_IMPORT_BATCH_ROWS} 条采集记录` });
  }
  if (capturePayloads.length > MAX_IMPORT_BATCH_ROWS) {
    return res.status(400).json({ error: `每批最多包含 ${MAX_IMPORT_BATCH_ROWS} 条采集数据` });
  }

  const db = getDatabase();
  const existingBatch = db.prepare(`SELECT import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version
    FROM workspace_import_batches WHERE team_id = ? AND import_id = ? AND batch_index = ?`)
    .get(req.team.id, importId, batchIndex);
  if (existingBatch) return res.json(importBatchResponse(db, req, existingBatch, true));

  const requestIdValue = requestId(req);
  const publishedEvents = [];
  let result;
  try {
    result = db.transaction(() => {
      const current = stateRow(db, req.team.id);
      const currentVersion = Number(current?.version || 0);
      if (!current || currentVersion <= 0) return { notInitialized: true };
      const previousState = normalizeWorkspaceState(parseJson(current.state_json, {}));
      const currentCaptures = new Map((previousState.captures || []).map(capture => [String(capture?.id), capture]));
      const payloadById = new Map(capturePayloads
        .filter(capture => capture && typeof capture === 'object' && !Array.isArray(capture))
        .map(capture => [String(capture.id || '').trim(), capture])
        .filter(([captureId]) => captureId));
      const ownerId = String(req.user.id ?? '').trim();
      const skippedIds = [];
      const duplicateSkippedIds = [];
      const permissionSkippedIds = [];
      const alreadyAbsentIds = [];
      const duplicateTargetIds = {};
      const acceptedCaptureIds = [];
      const newCustomers = [];
      const officialCustomers = (previousState.customers || []).filter(customer => customer?.approval !== '待确认');

      captureIds.forEach(captureId => {
        const currentCapture = currentCaptures.get(captureId);
        const payloadCapture = payloadById.get(captureId);
        const source = currentCapture
          ? {
            ...currentCapture,
            ...(payloadCapture || {}),
            id: captureId,
            created_by_user_id: currentCapture.created_by_user_id,
            createdBy: currentCapture.createdBy,
            created_by_username: currentCapture.created_by_username
          }
          : payloadCapture;
        if (!source) {
          skippedIds.push(captureId);
          alreadyAbsentIds.push(captureId);
          return;
        }
        const sourceOwner = captureOwnerId(source);
        if (sourceOwner && sourceOwner !== ownerId) {
          skippedIds.push(captureId);
          permissionSkippedIds.push(captureId);
          return;
        }
        if (source.confirmed || source.customerId) {
          skippedIds.push(captureId);
          duplicateSkippedIds.push(captureId);
          return;
        }
        const customer = {
          id: `capture-customer-${crypto.randomUUID()}`,
          sourceCaptureId: captureId,
          name: source.name || source.channel_account || source.douyin_nickname || '未命名客户',
          province: source.province || '',
          city: source.city || '',
          sales_status: source.sales_status || previousState.statuses?.[0]?.name || '新客户',
          phone: source.phone || '',
          identity: source.identity || '',
          qq: String(source.qq || ''),
          org_name: source.org_name || '',
          wechat_nickname: source.wechat_nickname || '',
          wechat_id: source.wechat_id || '',
          douyin_nickname: source.douyin_nickname || '',
          douyin_id: source.douyin_id || '',
          douyin_profile_url: source.douyin_profile_url || '',
          douyin_followers: source.douyin_followers || 0,
          moments_orders: source.moments_orders || 0,
          moments_orders_qualified: typeof source.moments_orders_qualified === 'boolean' ? source.moments_orders_qualified : undefined,
          channel_account: source.channel_account || '',
          official_account: source.official_account || '',
          address: source.address || '',
          remark: source.remark || '',
          managed_wechat_accounts: Array.isArray(source.managed_wechat_accounts)
            ? [...new Set(source.managed_wechat_accounts.map(value => String(value || '').trim()).filter(Boolean))]
            : (source.managed_wechat_account ? [String(source.managed_wechat_account).trim()] : []),
          managed_wechat_account: source.managed_wechat_account || (Array.isArray(source.managed_wechat_accounts) ? source.managed_wechat_accounts[0] : '') || '',
          qrCodes: source.qrCodes || undefined,
          approval: '正式',
          source: source.source || '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          statusHistory: [],
          userId: req.user.id,
          createdBy: req.user.display_name || req.user.username || '',
          created_by_user_id: req.user.id,
          created_by_username: req.user.username || '',
          joinedByUserId: req.user.id,
          joinedBy: req.user.display_name || req.user.username || '',
          joinedByUsername: req.user.username || ''
        };
        const officialMatches = captureDuplicateMatches(customer, [...officialCustomers, ...newCustomers]);
        if (officialMatches.length) {
          skippedIds.push(captureId);
          duplicateSkippedIds.push(captureId);
          if (officialMatches.length) duplicateTargetIds[captureId] = officialMatches.map(match => String(match.customer.id));
          return;
        }
        newCustomers.push(customer);
        acceptedCaptureIds.push(captureId);
      });

      if (!newCustomers.length) {
        db.prepare(`INSERT INTO workspace_import_batches
          (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version, request_id, created_by_user_id)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
          .run(req.team.id, importId, batchIndex, totalBatches, skippedIds.length, JSON.stringify(skippedIds), JSON.stringify({ duplicate: duplicateSkippedIds, permission: permissionSkippedIds, alreadyAbsent: alreadyAbsentIds }), currentVersion, requestIdValue, req.user.id);
        return { version: currentVersion, accepted: 0, acceptedIds: [], acceptedCaptureIds: [], skipped: skippedIds.length, skippedIds, duplicateSkippedIds, permissionSkippedIds, alreadyAbsentIds, duplicateTargetIds };
      }

      const acceptedSet = new Set(acceptedCaptureIds);
      const nextState = {
        ...previousState,
        customers: [...newCustomers, ...(previousState.customers || [])],
        capturePromotionTombstones: [
          ...(previousState.capturePromotionTombstones || []),
          ...acceptedCaptureIds.map((captureId, index) => ({
            id: String(captureId),
            customerId: String(newCustomers[index]?.id || ''),
            ownerId: String(req.user.id),
            identityKeys: captureStableIdentityKeys(newCustomers[index]),
            promotedAt: new Date().toISOString()
          }))
        ],
        captures: (previousState.captures || []).filter(capture => !acceptedSet.has(String(capture?.id)))
      };
      const nextVersion = currentVersion + 1;
      bumpCustomerSyncVersions(nextState, previousState);
      appendPriorityEvents(nextState, previousState, req, requestIdValue, publishedEvents, db, nextVersion);
      newCustomers.forEach(customer => publishedEvents.push(createSyncEvent(db, {
        teamId: req.team.id, entityType: 'customer', entityId: String(customer.id), action: 'customer.created',
        entityVersion: nextVersion, operatorUserId: req.user.id, requestId: requestIdValue,
        payload: { customerId: String(customer.id), customerName: customer.name || '', source: 'capture_promote_batch', captureId: acceptedCaptureIds[newCustomers.indexOf(customer)] }
      })));
      db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
        .run(JSON.stringify(nextState), nextVersion, req.user.id, req.team.id);
      const delta = publicWorkspaceDelta(previousState, nextState);
      publishedEvents.push(createSyncEvent(db, {
        teamId: req.team.id, entityType: 'workspace', entityId: String(req.team.id), action: 'workspace.updated',
        entityVersion: nextVersion, operatorUserId: req.user.id, requestId: requestIdValue,
        payload: { source: 'capture_promote_batch', importId, batchIndex, totalBatches, rowCount: newCustomers.length, skippedCount: skippedIds.length, patch: delta.patch, privateArrays: delta.privateArrays }
      }));
      db.prepare(`INSERT INTO operation_logs (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'workspace', ?, 'capture_promote_batch', ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify({ importId, batchIndex, totalBatches, acceptedCaptureIds, acceptedIds: newCustomers.map(customer => String(customer.id)), skippedIds, duplicateSkippedIds, permissionSkippedIds, alreadyAbsentIds }), requestIdValue, req.ip || '', req.get('user-agent') || '');
      db.prepare(`INSERT INTO workspace_import_batches
        (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version, request_id, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.team.id, importId, batchIndex, totalBatches, newCustomers.length, skippedIds.length, JSON.stringify(skippedIds), JSON.stringify({ duplicate: duplicateSkippedIds, permission: permissionSkippedIds, alreadyAbsent: alreadyAbsentIds }), nextVersion, requestIdValue, req.user.id);
      return { version: nextVersion, accepted: newCustomers.length, acceptedIds: newCustomers.map(customer => String(customer.id)), acceptedCaptureIds, skipped: skippedIds.length, skippedIds, duplicateSkippedIds, permissionSkippedIds, alreadyAbsentIds, duplicateTargetIds };
    })();
  } catch (error) {
    return sendSyncFailure(res, error, '客户采集加入客户库失败', requestIdValue);
  }
  if (result.notInitialized) return res.status(409).json({ error: '团队同步尚未初始化，请刷新页面后重试' });
  publishedEvents.forEach(event => publish(req.team.id, event));
  res.status(201).json({
    importId, batchIndex, totalBatches, accepted: result.accepted, acceptedIds: result.acceptedIds,
    acceptedCaptureIds: result.acceptedCaptureIds, skipped: result.skipped, skippedIds: result.skippedIds,
    duplicateSkippedIds: result.duplicateSkippedIds, duplicateSkipped: result.duplicateSkippedIds.length,
    duplicateTargetIds: result.duplicateTargetIds, permissionSkippedIds: result.permissionSkippedIds,
    permissionSkipped: result.permissionSkippedIds.length, alreadyAbsentIds: result.alreadyAbsentIds,
    version: result.version, cursor: syncCursor(db, req.team.id), replayed: false
  });
});

// Permanently delete selected customers and their customer-owned
// workspace/relational data. Pending customers are included only when the
// caller explicitly sends includePending=true. The batch record makes
// retries safe when the response is lost after the transaction commits.
router.post('/delete-customer-batch', (req, res) => {
  const body = req.body || {};
  const importId = String(body.importId || '').trim();
  const batchIndex = Number(body.batchIndex);
  const totalBatches = Number(body.totalBatches);
  const customerIds = Array.isArray(body.customerIds) ? [...new Set(body.customerIds.map(id => String(id).trim()).filter(Boolean))] : [];
  const includePending = body.includePending === true;
  const pendingOnly = body.pendingOnly === true;
  if (!importId || importId.length > 120) return res.status(400).json({ error: '批量删除任务编号无效' });
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || !Number.isInteger(totalBatches) || totalBatches < 1 || batchIndex >= totalBatches) {
    return res.status(400).json({ error: '批量删除批次编号无效' });
  }
  if (!customerIds.length || customerIds.length > MAX_IMPORT_BATCH_ROWS) {
    return res.status(400).json({ error: `每批必须包含 1-${MAX_IMPORT_BATCH_ROWS} 位客户` });
  }

  const db = getDatabase();
  const existingBatch = db.prepare(`SELECT import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version
    FROM workspace_import_batches WHERE team_id = ? AND import_id = ? AND batch_index = ?`)
    .get(req.team.id, importId, batchIndex);
  if (existingBatch) return res.json(importBatchResponse(db, req, existingBatch, true));

  const requestIdValue = requestId(req);
  const publishedEvents = [];
  let evidenceFiles = [];
  let result;
  try {
    result = db.transaction(() => {
      const current = stateRow(db, req.team.id);
      const currentVersion = Number(current?.version || 0);
      if (!current || currentVersion <= 0) return { notInitialized: true };
      const previousState = normalizeWorkspaceState(parseJson(current.state_json, {}));
      const selected = new Set(customerIds);
      const candidates = (previousState.customers || []).filter(customer => selected.has(String(customer?.id)));
      const deletable = candidates.filter(customer => pendingOnly ? customer?.approval === '待确认' : includePending || customer?.approval !== '待确认');
      const statusChangedIds = candidates.filter(customer => !deletable.includes(customer)).map(customer => String(customer.id));
      const foundIds = new Set(candidates.map(customer => String(customer.id)));
      const alreadyAbsentIds = customerIds.filter(id => !foundIds.has(id));
      const skippedIds = [...statusChangedIds, ...alreadyAbsentIds];
      const skipReasons = { alreadyAbsent: alreadyAbsentIds, statusChanged: statusChangedIds };
      const deletedIds = new Set(deletable.map(customer => String(customer.id)));
      if (!deletedIds.size) {
        db.prepare(`INSERT INTO workspace_import_batches
          (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version, request_id, created_by_user_id)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
          .run(req.team.id, importId, batchIndex, totalBatches, skippedIds.length, JSON.stringify(skippedIds), JSON.stringify(skipReasons), currentVersion, requestIdValue, req.user.id);
        return { version: currentVersion, deleted: 0, skipped: skippedIds.length, skippedIds, alreadyAbsentIds, statusChangedIds, filePaths: [] };
      }

      const removedFeedbackIds = new Set((previousState.feedback || [])
        .filter(item => deletedIds.has(String(item?.customerId)))
        .map(item => String(item?.id)));
      const relationBelongsToDeletedCustomer = item => deletedIds.has(String(item?.customerId));
      const nextState = {
        ...previousState,
        customers: (previousState.customers || []).filter(customer => !deletedIds.has(String(customer?.id))),
        tasks: (previousState.tasks || []).filter(task => !relationBelongsToDeletedCustomer(task) && !removedFeedbackIds.has(String(task?.feedbackId))),
        feedback: (previousState.feedback || []).filter(item => !relationBelongsToDeletedCustomer(item)),
        chats: (previousState.chats || []).filter(item => !relationBelongsToDeletedCustomer(item)),
        captures: (previousState.captures || []).filter(item => !relationBelongsToDeletedCustomer(item)),
        duplicateResolutions: (previousState.duplicateResolutions || []).filter(item =>
          !deletedIds.has(String(item?.customerId)) && !deletedIds.has(String(item?.duplicateCustomerId)))
      };
      const permission = validateWorkspaceCustomerChanges(db, req, previousState, nextState);
      if (!permission.ok) return { denied: permission };

      const numericIds = [...deletedIds].filter(id => /^\d+$/.test(id)).map(Number);
      if (numericIds.length) {
        const placeholders = numericIds.map(() => '?').join(',');
        const feedbackIds = db.prepare(`SELECT id FROM feedback WHERE team_id = ? AND customer_id IN (${placeholders})`)
          .all(req.team.id, ...numericIds).map(row => Number(row.id));
        if (feedbackIds.length) {
          const feedbackPlaceholders = feedbackIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM tasks WHERE team_id = ? AND (customer_id IN (${placeholders}) OR feedback_id IN (${feedbackPlaceholders}))`)
            .run(req.team.id, ...numericIds, ...feedbackIds);
        } else {
          db.prepare(`DELETE FROM tasks WHERE team_id = ? AND customer_id IN (${placeholders})`).run(req.team.id, ...numericIds);
        }
        db.prepare(`DELETE FROM feedback WHERE team_id = ? AND customer_id IN (${placeholders})`).run(req.team.id, ...numericIds);
        db.prepare(`DELETE FROM chat_records WHERE team_id = ? AND customer_id IN (${placeholders})`).run(req.team.id, ...numericIds);
        db.prepare(`DELETE FROM customer_status_history WHERE team_id = ? AND customer_id IN (${placeholders})`).run(req.team.id, ...numericIds);
        db.prepare(`DELETE FROM customers WHERE team_id = ? AND id IN (${placeholders})`).run(req.team.id, ...numericIds);
      }
      const idPlaceholders = [...deletedIds].map(() => '?').join(',');
      evidenceFiles = db.prepare(`SELECT file_path FROM customer_evidence WHERE team_id = ? AND customer_id IN (${idPlaceholders})`)
        .all(req.team.id, ...deletedIds).map(row => row.file_path).filter(Boolean);
      db.prepare(`DELETE FROM customer_evidence WHERE team_id = ? AND customer_id IN (${idPlaceholders})`).run(req.team.id, ...deletedIds);
      db.prepare(`DELETE FROM customer_data_permissions WHERE team_id = ? AND customer_id IN (${idPlaceholders})`).run(req.team.id, ...deletedIds);
      db.prepare(`DELETE FROM workspace_customer_status_history WHERE team_id = ? AND customer_id IN (${idPlaceholders})`).run(req.team.id, ...deletedIds);

      const nextVersion = currentVersion + 1;
      const deletedCustomers = candidates.filter(customer => deletedIds.has(String(customer.id)));
      deletedCustomers.forEach(customer => {
        publishedEvents.push(createSyncEvent(db, {
          teamId: req.team.id, entityType: 'customer', entityId: String(customer.id), action: 'customer.deleted',
          entityVersion: nextVersion, operatorUserId: req.user.id, requestId: requestIdValue,
          payload: { customerId: String(customer.id), customerName: customer.name || '', source: 'customer_delete_batch' }
        }));
      });
      db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
        .run(JSON.stringify(nextState), nextVersion, req.user.id, req.team.id);
      const delta = publicWorkspaceDelta(previousState, nextState);
      publishedEvents.push(createSyncEvent(db, {
        teamId: req.team.id, entityType: 'workspace', entityId: String(req.team.id), action: 'workspace.updated',
        entityVersion: nextVersion, operatorUserId: req.user.id, requestId: requestIdValue,
        payload: { source: 'customer_delete_batch', importId, batchIndex, totalBatches, includePending, pendingOnly, rowCount: deletedIds.size, skippedCount: skippedIds.length, patch: delta.patch, privateArrays: delta.privateArrays }
      }));
      db.prepare(`INSERT INTO operation_logs (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'workspace', ?, 'customer_delete_batch', ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify({ importId, batchIndex, totalBatches, includePending, pendingOnly, customerIds: [...deletedIds], skippedIds }), requestIdValue, req.ip || '', req.get('user-agent') || '');
      db.prepare(`INSERT INTO workspace_import_batches
        (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version, request_id, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.team.id, importId, batchIndex, totalBatches, deletedIds.size, skippedIds.length, JSON.stringify(skippedIds), JSON.stringify(skipReasons), nextVersion, requestIdValue, req.user.id);
      return { version: nextVersion, deleted: deletedIds.size, skipped: skippedIds.length, skippedIds, alreadyAbsentIds, statusChangedIds, filePaths: evidenceFiles };
    })();
  } catch (error) {
    return sendSyncFailure(res, error, '批量删除客户失败', requestIdValue);
  }

  if (result.notInitialized) return res.status(409).json({ error: '团队同步尚未初始化，请刷新页面后重试' });
  if (result.denied) return res.status(403).json({
    error: `您没有删除客户“${result.denied.customerName || '未命名客户'}”的权限，请先向创建人申请`,
    code: 'CUSTOMER_PERMISSION_REQUIRED', customerId: result.denied.customerId,
    customerName: result.denied.customerName, ownerUserId: result.denied.ownerUserId
  });
  const evidenceRoot = CUSTOMER_EVIDENCE_DIR;
  (result.filePaths || []).forEach(filePath => {
    const resolved = path.resolve(String(filePath));
    if (resolved === evidenceRoot || !resolved.startsWith(`${evidenceRoot}${path.sep}`)) return;
    try { fs.unlinkSync(resolved); } catch (error) { if (error.code !== 'ENOENT') console.warn('[sync] customer evidence file cleanup failed', resolved, error.message); }
  });
  publishedEvents.forEach(event => publish(req.team.id, event));
  res.status(201).json({
    importId, batchIndex, totalBatches, accepted: result.deleted, skipped: result.skipped,
    skippedIds: result.skippedIds, alreadyAbsentIds: result.alreadyAbsentIds, statusChangedIds: result.statusChangedIds,
    version: result.version, cursor: syncCursor(db, req.team.id), replayed: false
  });
});

// Permanently delete selected capture records owned by the current user.
// Capture rows are private workspace data, so their changes are committed
// here instead of relying on a full workspace patch from the browser.
router.post('/delete-capture-batch', (req, res) => {
  const body = req.body || {};
  const importId = String(body.importId || '').trim();
  const batchIndex = Number(body.batchIndex);
  const totalBatches = Number(body.totalBatches);
  const captureIds = Array.isArray(body.captureIds)
    ? [...new Set(body.captureIds.map(id => String(id).trim()).filter(Boolean))]
    : [];
  if (!importId || importId.length > 120) return res.status(400).json({ error: '批量删除采集任务编号无效' });
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || !Number.isInteger(totalBatches) || totalBatches < 1 || batchIndex >= totalBatches) {
    return res.status(400).json({ error: '批量删除采集批次编号无效' });
  }
  if (!captureIds.length || captureIds.length > MAX_IMPORT_BATCH_ROWS) {
    return res.status(400).json({ error: `每批必须包含 1-${MAX_IMPORT_BATCH_ROWS} 条采集记录` });
  }

  const db = getDatabase();
  const existingBatch = db.prepare(`SELECT import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version
    FROM workspace_import_batches WHERE team_id = ? AND import_id = ? AND batch_index = ?`)
    .get(req.team.id, importId, batchIndex);
  if (existingBatch) return res.json(importBatchResponse(db, req, existingBatch, true));

  const requestIdValue = requestId(req);
  const publishedEvents = [];
  let result;
  try {
    result = db.transaction(() => {
      const current = stateRow(db, req.team.id);
      const currentVersion = Number(current?.version || 0);
      if (!current || currentVersion <= 0) return { notInitialized: true };
      const previousState = normalizeWorkspaceState(parseJson(current.state_json, {}));
      const selected = new Set(captureIds);
      const ownerId = String(req.user.id ?? '').trim();
      const candidates = (previousState.captures || []).filter(capture => selected.has(String(capture?.id)));
      const deletable = candidates.filter(capture => captureOwnerId(capture) === ownerId);
      const permissionSkippedIds = candidates
        .filter(capture => !deletable.includes(capture))
        .map(capture => String(capture.id));
      const foundIds = new Set(candidates.map(capture => String(capture.id)));
      const alreadyAbsentIds = captureIds.filter(id => !foundIds.has(id));
      const skippedIds = [...permissionSkippedIds, ...alreadyAbsentIds];
      const skipReasons = { alreadyAbsent: alreadyAbsentIds, permission: permissionSkippedIds };
      const deletedIds = new Set(deletable.map(capture => String(capture.id)));
      if (!deletedIds.size) {
        db.prepare(`INSERT INTO workspace_import_batches
          (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version, request_id, created_by_user_id)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
          .run(req.team.id, importId, batchIndex, totalBatches, skippedIds.length, JSON.stringify(skippedIds), JSON.stringify(skipReasons), currentVersion, requestIdValue, req.user.id);
        return { version: currentVersion, deleted: 0, skipped: skippedIds.length, skippedIds, alreadyAbsentIds, permissionSkippedIds };
      }

      const nextState = {
        ...previousState,
        captures: (previousState.captures || []).filter(capture => !deletedIds.has(String(capture?.id)))
      };
      const nextVersion = currentVersion + 1;
      db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
        .run(JSON.stringify(nextState), nextVersion, req.user.id, req.team.id);
      publishedEvents.push(createSyncEvent(db, {
        teamId: req.team.id,
        entityType: 'workspace',
        entityId: String(req.team.id),
        action: 'workspace.updated',
        entityVersion: nextVersion,
        operatorUserId: req.user.id,
        requestId: requestIdValue,
        payload: {
          source: 'capture_delete_batch', importId, batchIndex, totalBatches,
          rowCount: deletedIds.size, skippedCount: skippedIds.length, privateArrays: ['captures']
        }
      }));
      db.prepare(`INSERT INTO operation_logs (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'workspace', ?, 'capture_delete_batch', ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify({ importId, batchIndex, totalBatches, captureIds: [...deletedIds], skippedIds }), requestIdValue, req.ip || '', req.get('user-agent') || '');
      db.prepare(`INSERT INTO workspace_import_batches
        (team_id, import_id, batch_index, total_batches, row_count, skipped_count, skipped_ids, skip_reasons, version, request_id, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.team.id, importId, batchIndex, totalBatches, deletedIds.size, skippedIds.length, JSON.stringify(skippedIds), JSON.stringify(skipReasons), nextVersion, requestIdValue, req.user.id);
      return { version: nextVersion, deleted: deletedIds.size, skipped: skippedIds.length, skippedIds, alreadyAbsentIds, permissionSkippedIds };
    })();
  } catch (error) {
    return sendSyncFailure(res, error, '批量删除采集记录失败', requestIdValue);
  }
  if (result.notInitialized) return res.status(409).json({ error: '团队同步尚未初始化，请刷新页面后重试' });
  publishedEvents.forEach(event => publish(req.team.id, event));
  res.status(201).json({
    importId, batchIndex, totalBatches, accepted: result.deleted, skipped: result.skipped,
    skippedIds: result.skippedIds, alreadyAbsentIds: result.alreadyAbsentIds, permissionSkippedIds: result.permissionSkippedIds,
    permissionSkipped: result.permissionSkippedIds.length, version: result.version, cursor: syncCursor(db, req.team.id), replayed: false
  });
});

router.get('/changes', (req, res) => {
  const db = getDatabase();
  const cursor = Math.max(0, Number(req.query.cursor || 0) || 0);
  const rows = db.prepare('SELECT * FROM sync_events WHERE team_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
    .all(req.team.id, cursor, MAX_EVENTS);
  const latest = rows.length ? Number(rows[rows.length - 1].id) : Number(db.prepare('SELECT COALESCE(MAX(id), 0) cursor FROM sync_events WHERE team_id = ?').get(req.team.id).cursor);
  res.json({ cursor: latest, events: rows.map(eventRow), hasMore: rows.length === MAX_EVENTS, serverTime: new Date().toISOString() });
});

router.post('/bootstrap', (req, res) => {
  const db = getDatabase();
  if (!req.body?.state || typeof req.body.state !== 'object' || Array.isArray(req.body.state)) return res.status(400).json({ error: '缺少可迁移的本地业务数据' });
  const incoming = normalizeWorkspaceState(req.body.state, {
    defaultCaptureOwnerId: req.user.id,
    defaultCaptureOwnerName: req.user.display_name || req.user.username,
    defaultTaskOwnerId: req.user.id,
    defaultTaskOwnerName: req.user.display_name || req.user.username
  });
  const rid = requestId(req);
  let event;
  const result = db.transaction(() => {
    const current = stateRow(db, req.team.id);
    if (Number(current?.version || 0) > 0) return { initialized: false, snapshot: publicSnapshot(db, req) };
    const nextVersion = 1;
    const nextState = normalizeWorkspaceState(JSON.parse(JSON.stringify(incoming)), {
      defaultCaptureOwnerId: req.user.id,
      defaultCaptureOwnerName: req.user.display_name || req.user.username,
      defaultTaskOwnerId: req.user.id,
      defaultTaskOwnerName: req.user.display_name || req.user.username
    });
    const createdEvents = [];
    appendServerStatusHistory(nextState, {}, req, rid, createdEvents, db, nextVersion);
    appendPriorityEvents(nextState, {}, req, rid, createdEvents, db, nextVersion);
    db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, initialized_by_user_id = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
      .run(JSON.stringify(nextState), nextVersion, req.user.id, req.user.id, req.team.id);
    event = createSyncEvent(db, {
      teamId: req.team.id, entityType: 'workspace', entityId: String(req.team.id), action: 'workspace.initialized',
      entityVersion: nextVersion, operatorUserId: req.user.id, requestId: rid,
      payload: { version: nextVersion, customerCount: Array.isArray(nextState.customers) ? nextState.customers.length : 0 }
    });
    db.prepare(`INSERT INTO operation_logs (team_id, operator_user_id, entity_type, entity_id, action, after_data, request_id, ip_address, user_agent)
      VALUES (?, ?, 'workspace', ?, 'initialized', ?, ?, ?, ?)`)
      .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify(event.payload), rid, req.ip, req.get('user-agent') || '');
    return { initialized: true, statusEvents: createdEvents };
  })();
  if (!result.initialized) return res.json(result.snapshot);
  result.statusEvents.forEach((item) => publish(req.team.id, item));
  publish(req.team.id, event);
  res.status(201).json(publicSnapshot(db, req));
});

router.put('/state', (req, res) => {
  const db = getDatabase();
  const incoming = normalizeWorkspaceState(req.body?.state, {
    defaultCaptureOwnerId: req.user.id,
    defaultCaptureOwnerName: req.user.display_name || req.user.username,
    defaultTaskOwnerId: req.user.id,
    defaultTaskOwnerName: req.user.display_name || req.user.username
  });
  const baseVersion = Number(req.body?.baseVersion);
  const rid = requestId(req);
  if (!req.body?.state || typeof req.body.state !== 'object' || Array.isArray(req.body.state)) return res.status(400).json({ error: '同步数据格式不正确' });
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return res.status(400).json({ error: '缺少有效的数据版本号' });

  const cached = db.prepare('SELECT response_json FROM idempotency_requests WHERE team_id = ? AND request_id = ?').get(req.team.id, rid);
  if (cached?.response_json) {
    const cachedResponse = parseJson(cached.response_json, null);
    return res.json(cachedResponse?.__syncResponseMarker ? publicSnapshot(db, req) : (cachedResponse || publicSnapshot(db, req)));
  }

  let publishedEvents = [];
  let response;
  let outcome;
  try {
    outcome = db.transaction(() => {
      const current = stateRow(db, req.team.id);
      const currentVersion = Number(current?.version || 0);
      if (currentVersion !== baseVersion) return { conflict: true, currentVersion };
      const previousState = currentVersion > 0 ? normalizeWorkspaceState(parseJson(current.state_json, {})) : {};
      const nextState = mergeWorkspaceCapturesForUser(previousState, JSON.parse(JSON.stringify(incoming)), req.user);
      if (petGuideConfigChanged(previousState, nextState) && !canManagePetGuideConfig(req)) {
        return { conflict: false, petGuideDenied: true };
      }
      const permission = validateWorkspaceCustomerChanges(db, req, previousState, nextState);
      if (!permission.ok) return { conflict: false, denied: permission };
      if (sameWorkspaceState(previousState, nextState)) return { conflict: false, unchanged: true };
      const nextVersion = currentVersion + 1;
      appendServerStatusHistory(nextState, previousState, req, rid, publishedEvents, db, nextVersion);
      appendPriorityEvents(nextState, previousState, req, rid, publishedEvents, db, nextVersion);
      db.prepare(`UPDATE workspace_states SET state_json = ?, version = ?, initialized_by_user_id = COALESCE(initialized_by_user_id, ?), updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`)
        .run(JSON.stringify(nextState), nextVersion, req.user.id, req.user.id, req.team.id);
      const workspaceEvent = createSyncEvent(db, {
        teamId: req.team.id, entityType: 'workspace', entityId: String(req.team.id), action: 'workspace.updated',
        entityVersion: nextVersion, operatorUserId: req.user.id, requestId: rid, payload: { version: nextVersion }
      });
      publishedEvents.push(workspaceEvent);
      db.prepare(`INSERT INTO operation_logs (team_id, operator_user_id, entity_type, entity_id, action, before_data, after_data, request_id, ip_address, user_agent)
        VALUES (?, ?, 'workspace', ?, 'updated', ?, ?, ?, ?, ?)`)
        .run(req.team.id, req.user.id, String(req.team.id), JSON.stringify({ version: currentVersion }), JSON.stringify({ version: nextVersion }), rid, req.ip, req.get('user-agent') || '');
      return { conflict: false };
    })();
  } catch (error) {
    return sendSyncFailure(res, error, '团队数据同步写入失败', rid);
  }

  if (outcome.conflict) {
    return res.status(409).json({ error: '团队数据已被其他成员更新', ...publicSnapshot(db, req) });
  }
  if (outcome.petGuideDenied) {
    return res.status(403).json({ error: '只有演示管理员 demo 可以配置桌宠' });
  }
  if (outcome.denied) {
    return res.status(403).json({
      error: `您没有编辑客户“${outcome.denied.customerName || '未命名客户'}”的权限，请先向创建人申请`,
      code: 'CUSTOMER_PERMISSION_REQUIRED',
      customerId: outcome.denied.customerId,
      customerName: outcome.denied.customerName,
      ownerUserId: outcome.denied.ownerUserId,
      ...publicSnapshot(db, req)
    });
  }
  response = publicSnapshot(db, req);
  // Only keep a marker for retries. Caching the full snapshot here duplicated
  // the entire workspace JSON on every save and could exhaust the database.
  db.prepare('INSERT OR IGNORE INTO idempotency_requests (team_id, user_id, request_id, response_json) VALUES (?, ?, ?, ?)')
    .run(req.team.id, req.user.id, rid, JSON.stringify({ __syncResponseMarker: true, version: response.version, cursor: response.cursor }));
  publishedEvents.forEach((item) => publish(req.team.id, item));
  res.json(response);
});

router.get('/status-history', (req, res) => {
  const db = getDatabase();
  const params = [req.team.id];
  let where = 'WHERE h.team_id = ?';
  if (req.query.customer_id) { where += ' AND h.customer_id = ?'; params.push(String(req.query.customer_id)); }
  const rows = db.prepare(`SELECT h.*, u.username operator_username, u.display_name operator_display_name
    FROM workspace_customer_status_history h LEFT JOIN users u ON u.id = h.operator_user_id
    ${where} ORDER BY h.created_at DESC LIMIT 1000`).all(...params);
  res.json(rows);
});

module.exports = router;
