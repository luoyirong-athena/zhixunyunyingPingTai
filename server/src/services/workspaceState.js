'use strict';

// duplicateResolutions is UI metadata, not customer data. Older client versions
// could turn each string into a character-keyed object during a conflict merge,
// and then append the same resolution repeatedly. Keep the metadata compact and
// canonical so sync responses cannot block the web server.
const MAX_DUPLICATE_RESOLUTIONS = 10000;

function normalizeResolutionKey(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  if (typeof value.key === 'string') return value.key.trim();
  if (typeof value.value === 'string') return value.value.trim();

  const indexes = Object.keys(value)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b));
  return indexes.length ? indexes.map((key) => String(value[key] ?? '')).join('').trim() : '';
}

function normalizeDuplicateResolutions(value) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    const key = normalizeResolutionKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result.length > MAX_DUPLICATE_RESOLUTIONS
    ? result.slice(-MAX_DUPLICATE_RESOLUTIONS)
    : result;
}

function normalizedUserId(value) {
  const id = String(value ?? '').trim();
  return id;
}

function recordOwnerId(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
  return [record.created_by_user_id, record.createdByUserId, record.user_id, record.userId]
    .map(normalizedUserId)
    .find(Boolean) || '';
}

function captureOwnerId(capture) {
  return recordOwnerId(capture);
}

function taskOwnerId(task) {
  return recordOwnerId(task);
}

function ownerContext(value, name) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      id: normalizedUserId(value.id),
      name: String(value.display_name || value.username || '').trim()
    };
  }
  return { id: normalizedUserId(value), name: String(name || '').trim() };
}

function normalizeOwnedRecord(record, fallbackOwner, ownerIdOf) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const item = { ...record };
  const ownerId = ownerIdOf(item) || fallbackOwner.id;
  if (ownerId) item.created_by_user_id = /^\d+$/.test(ownerId) ? Number(ownerId) : ownerId;
  if (!String(item.createdBy || item.created_by_name || '').trim() && fallbackOwner.name && ownerId === fallbackOwner.id) {
    item.createdBy = fallbackOwner.name;
  }
  return item;
}

function normalizeCapture(capture, fallbackOwner) {
  return normalizeOwnedRecord(capture, fallbackOwner, captureOwnerId);
}

function captureStableIdentityKeys(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  const keys = [];
  capturePhoneValues(record.phone).forEach((phone) => keys.push(`phone:${phone}`));
  [
    ['wechat', record.wechat_id ?? record.wechatId],
    ['douyin', record.douyin_id ?? record.douyinId],
    ['channel', record.channel_account ?? record.channelAccount]
  ].forEach(([prefix, value]) => {
    const normalized = captureValue(value);
    if (normalized) keys.push(`${prefix}:${normalized}`);
  });
  return [...new Set(keys)];
}

function capturePromotionOwnerId(record) {
  if (!record || typeof record !== 'object') return '';
  return [record.ownerId, record.promotedByUserId, record.promoted_by_user_id,
    record.created_by_user_id, record.createdByUserId, record.user_id, record.userId]
    .map(normalizedUserId).find(Boolean) || '';
}

function normalizeCapturePromotionTombstones(value) {
  const result = new Map();
  (Array.isArray(value) ? value : []).forEach((item) => {
    const id = String(typeof item === 'string' ? item : item?.id ?? item?.captureId ?? '').trim();
    if (!id) return;
    const normalized = typeof item === 'string' ? { id } : { ...item, id };
    const previous = result.get(id);
    const identityKeys = [...new Set([
      ...(Array.isArray(previous?.identityKeys) ? previous.identityKeys : []),
      ...(Array.isArray(normalized.identityKeys) ? normalized.identityKeys : []),
      ...captureStableIdentityKeys(normalized)
    ].map((key) => String(key || '').trim().toLowerCase()).filter((key) => /^(?:phone|wechat|douyin|channel):/.test(key)))];
    const ownerId = capturePromotionOwnerId(previous) || capturePromotionOwnerId(normalized);
    result.set(id, {
      ...normalized,
      ...(previous || {}),
      id,
      ...(ownerId ? { ownerId } : {}),
      ...(identityKeys.length ? { identityKeys } : {})
    });
  });
  return [...result.values()];
}

function capturePromotionTombstone(capture, values = {}) {
  const id = String(values.id ?? capture?.id ?? '').trim();
  const ownerId = capturePromotionOwnerId(values) || captureOwnerId(capture);
  const identityKeys = [...new Set([
    ...(Array.isArray(values.identityKeys) ? values.identityKeys : []),
    ...captureStableIdentityKeys(capture)
  ])];
  return {
    ...values,
    id,
    ...(ownerId ? { ownerId } : {}),
    ...(identityKeys.length ? { identityKeys } : {})
  };
}

function identityKeysForOwner(index, ownerId) {
  const owner = normalizedUserId(ownerId);
  if (!owner) return new Set();
  if (!index.has(owner)) index.set(owner, new Set());
  return index.get(owner);
}

function removeCompletedCaptureRows(state) {
  const officialCustomers = (Array.isArray(state.customers) ? state.customers : [])
    .filter((customer) => String(customer?.approval || customer?.approval_status || '正式') !== '待确认');
  const officialCustomerIds = new Set(officialCustomers
    .map((customer) => String(customer?.id ?? '').trim())
    .filter(Boolean));
  const tombstones = new Map(normalizeCapturePromotionTombstones(state.capturePromotionTombstones).map((item) => [String(item.id), item]));
  const blockedIdentitiesByOwner = new Map();
  tombstones.forEach((item) => {
    const identities = identityKeysForOwner(blockedIdentitiesByOwner, capturePromotionOwnerId(item));
    (item.identityKeys || []).forEach((key) => identities.add(String(key)));
  });
  officialCustomers.forEach((customer) => {
    const sourceCaptureId = String(customer?.sourceCaptureId ?? customer?.source_capture_id ?? '').trim();
    if (!sourceCaptureId) return;
    const tombstone = capturePromotionTombstone(customer, {
      ...(tombstones.get(sourceCaptureId) || {}),
      id: sourceCaptureId,
      customerId: String(customer?.id ?? '').trim(),
      ownerId: recordOwnerId(customer),
      promotedAt: customer?.joinedAt || customer?.joined_at || customer?.createdAt || customer?.created_at || ''
    });
    tombstones.set(sourceCaptureId, tombstone);
    const identities = identityKeysForOwner(blockedIdentitiesByOwner, capturePromotionOwnerId(tombstone));
    (tombstone.identityKeys || []).forEach((key) => identities.add(String(key)));
  });
  state.captures = (Array.isArray(state.captures) ? state.captures : [])
    .filter((capture) => {
      const captureId = String(capture?.id ?? '').trim();
      const customerId = String(capture?.customerId ?? capture?.customer_id ?? '').trim();
      const ownerId = captureOwnerId(capture);
      const blockedIdentities = identityKeysForOwner(blockedIdentitiesByOwner, ownerId);
      const identityBlocked = captureStableIdentityKeys(capture).some((key) => blockedIdentities.has(key));
      if (captureId && (capture?.confirmed || tombstones.has(captureId) || identityBlocked || officialCustomerIds.has(customerId))) {
        if (!tombstones.has(captureId)) {
          const tombstone = capturePromotionTombstone(capture, {
            id: captureId,
            ownerId,
          customerId,
          promotedAt: capture?.confirmedAt || capture?.processedAt || ''
          });
          tombstones.set(captureId, tombstone);
          (tombstone.identityKeys || []).forEach((key) => blockedIdentities.add(String(key)));
        }
        return false;
      }
      return true;
    });
  state.capturePromotionTombstones = [...tombstones.values()];
  return state;
}

function captureValue(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s\u3000]+/g, '');
}

function capturePhoneValues(value) {
  // Match the browser-side capture identity rule: only complete mainland
  // mobile numbers are stable cross-device keys.
  return [...new Set(String(value ?? '').match(/1[3-9]\d{9}/g) || [])];
}

function captureIdentityKeys(capture) {
  if (!capture || typeof capture !== 'object') return [];
  const keys = captureStableIdentityKeys(capture);
  const customerId = captureValue(capture.customerId ?? capture.customer_id);
  if (customerId) keys.push(`customer:${customerId}`);
  // Use a platform-scoped name only when paste recognition produced no
  // stable account/contact identity. Province reduces false matches for
  // common display names while still merging repeated copies of one profile.
  if (!keys.length) {
    const platform = capture.platform === 'wechat-channel' ? 'channel' : 'douyin';
    const name = captureValue(platform === 'channel'
      ? (capture.channel_account || capture.name || capture.org_name)
      : (capture.douyin_nickname || capture.name));
    const province = captureValue(capture.province);
    if (name) keys.push(`${platform}-name:${name}|${province}`);
  }
  return [...new Set(keys)];
}

function captureTime(capture) {
  const parsed = Date.parse(capture?.updatedAt || capture?.updated_at || capture?.createdAt || capture?.created_at || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeCaptureRecords(current, incoming) {
  const currentTime = captureTime(current);
  const incomingTime = captureTime(incoming);
  const first = incomingTime >= currentTime ? incoming : current;
  const second = first === incoming ? current : incoming;
  const merged = { ...current };
  const fields = new Set([...Object.keys(current || {}), ...Object.keys(incoming || {})]);
  fields.forEach((field) => {
    if (['id', 'createdAt', 'created_at', 'created_by_user_id', 'createdByUserId', 'userId', 'user_id'].includes(field)) return;
    const preferred = first?.[field];
    const fallback = second?.[field];
    if (preferred !== undefined && preferred !== null && String(preferred).trim() !== '') merged[field] = preferred;
    else if (fallback !== undefined && fallback !== null && String(fallback).trim() !== '') merged[field] = fallback;
  });
  merged.id = current.id ?? incoming.id;
  merged.createdAt = current.createdAt || current.created_at || incoming.createdAt || incoming.created_at;
  const latestTime = Math.max(incomingTime, currentTime);
  // Synchronizing the same record must not make it look newly edited.
  merged.updatedAt = latestTime ? new Date(latestTime).toISOString()
    : (current.updatedAt || current.updated_at || incoming.updatedAt || incoming.updated_at || '');
  return merged;
}

function dedupeCaptureRows(captures, ownerId = '') {
  const result = [];
  const keyToIndex = new Map();
  for (const capture of Array.isArray(captures) ? captures : []) {
    if (!capture || (ownerId && captureOwnerId(capture) !== ownerId)) {
      result.push(capture);
      continue;
    }
    const keys = captureIdentityKeys(capture);
    const matches = [...new Set(keys.map((key) => keyToIndex.get(key)).filter((index) => index !== undefined))];
    if (!matches.length) {
      const index = result.length;
      result.push(capture);
      keys.forEach((key) => keyToIndex.set(key, index));
      continue;
    }
    const keepIndex = matches[0];
    result[keepIndex] = mergeCaptureRecords(result[keepIndex], capture);
    const removed = new Set(matches.slice(1).sort((a, b) => b - a));
    for (const index of removed) result.splice(index, 1);
    // Rebuild indexes after a merge/removal so every identity points at the
    // surviving row and transitive duplicates are folded into it as well.
    keyToIndex.clear();
    result.forEach((item, index) => {
      if (ownerId && captureOwnerId(item) !== ownerId) return;
      captureIdentityKeys(item).forEach((key) => keyToIndex.set(key, index));
    });
  }
  return result;
}

function normalizeTask(task, fallbackOwner) {
  return normalizeOwnedRecord(task, fallbackOwner, taskOwnerId);
}

function normalizeWorkspaceState(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const state = { ...value };
  const captureFallbackOwner = ownerContext(options.defaultCaptureOwnerId, options.defaultCaptureOwnerName);
  const taskFallbackOwner = ownerContext(options.defaultTaskOwnerId, options.defaultTaskOwnerName);
  state.captures = (Array.isArray(state.captures) ? state.captures : [])
    .map((capture) => normalizeCapture(capture, captureFallbackOwner))
    .filter(Boolean);
  state.capturePromotionTombstones = normalizeCapturePromotionTombstones(state.capturePromotionTombstones);
  removeCompletedCaptureRows(state);
  if (options.skipCaptureDedupe !== true) {
    const captureOwners = [...new Set(state.captures.map(captureOwnerId).filter(Boolean))];
    captureOwners.forEach((ownerId) => {
      state.captures = dedupeCaptureRows(state.captures, ownerId);
    });
  }
  state.tasks = (Array.isArray(state.tasks) ? state.tasks : [])
    .map((task) => normalizeTask(task, taskFallbackOwner))
    .filter(Boolean);
  state.duplicateResolutions = normalizeDuplicateResolutions(state.duplicateResolutions);
  return state;
}

function scopeWorkspaceStateForUser(value, user, options = {}) {
  const state = normalizeWorkspaceState(value, options);
  const owner = ownerContext(user);
  if (!owner.id) {
    state.captures = [];
    return state;
  }
  state.captures = state.captures.filter((capture) => captureOwnerId(capture) === owner.id);
  return state;
}

function mergeWorkspaceCapturesForUser(previousValue, incomingValue, user, options = {}) {
  const owner = ownerContext(user);
  const previous = normalizeWorkspaceState(previousValue);
  const incoming = normalizeWorkspaceState(incomingValue, {
    defaultCaptureOwnerId: owner.id,
    defaultCaptureOwnerName: owner.name
  });
  if (!owner.id) return incoming;

  // A user receives only their own capture rows. Preserve every other user's
  // rows when that scoped snapshot is saved back, and reject attempts to reuse
  // an id that is already owned by another member.
  //
  // Ordinary sync patches are built from a user-scoped snapshot. An omitted
  // own row therefore means "not present in this patch", not "delete it".
  // Only IDs explicitly present in the patch's remove operation are deletions.
  const normalizedTombstones = normalizeCapturePromotionTombstones([
    ...normalizeCapturePromotionTombstones(previous.capturePromotionTombstones),
    ...normalizeCapturePromotionTombstones(incoming.capturePromotionTombstones)
  ]);
  const tombstones = new Map(normalizedTombstones.map((item) => [String(item.id), item]));
  incoming.capturePromotionTombstones = normalizedTombstones;
  incoming.captures = incoming.captures.filter((capture) => !tombstones.has(String(capture?.id ?? '')));
  const protectedCustomerIds = new Set(normalizedTombstones
    .map((item) => String(item?.customerId ?? '').trim())
    .filter(Boolean));
  const incomingCustomerIds = new Set((Array.isArray(incoming.customers) ? incoming.customers : [])
    .map((customer) => String(customer?.id ?? '').trim())
    .filter(Boolean));
  const omittedProtectedCustomers = (Array.isArray(previous.customers) ? previous.customers : [])
    .filter((customer) => {
      const id = String(customer?.id ?? '').trim();
      return id
        && protectedCustomerIds.has(id)
        && !incomingCustomerIds.has(id)
        && String(customer?.approval || customer?.approval_status || '正式') !== '待确认';
    });
  if (omittedProtectedCustomers.length) {
    incoming.customers = [
      ...omittedProtectedCustomers,
      ...(Array.isArray(incoming.customers) ? incoming.customers : [])
    ];
  }
  const otherCaptures = previous.captures.filter((capture) => captureOwnerId(capture) !== owner.id);
  const protectedIds = new Set(otherCaptures.map((capture) => String(capture.id ?? '')).filter(Boolean));
  const preserveOmitted = options.preserveOmitted === true;
  const removedIds = new Set((options.removedCaptureIds || []).map((id) => String(id)).filter(Boolean));
  const ownCaptures = incoming.captures.filter((capture) => {
    if (captureOwnerId(capture) !== owner.id) return false;
    const id = String(capture.id ?? '');
    return !id || !protectedIds.has(id);
  });
  const ownById = new Map(ownCaptures
    .map((capture) => [String(capture.id ?? ''), capture])
    .filter(([id]) => id));
  const mergedCaptures = [];
  for (const capture of previous.captures) {
    if (captureOwnerId(capture) !== owner.id) {
      mergedCaptures.push(capture);
      continue;
    }
    const id = String(capture.id ?? '');
    if (id && removedIds.has(id)) continue;
    if (preserveOmitted && (!id || !ownById.has(id))) {
      // Keep an existing own capture that was not explicitly removed. This
      // protects records when a partial/scoped patch omits them accidentally.
      mergedCaptures.push(capture);
      continue;
    }
    if (!id || !ownById.has(id)) continue;
    mergedCaptures.push(ownById.get(id));
    ownById.delete(id);
  }
  for (const capture of ownCaptures) {
    const id = String(capture.id ?? '');
    if (!id || ownById.has(id)) {
      mergedCaptures.push(capture);
      if (id) ownById.delete(id);
    }
  }
  incoming.captures = dedupeCaptureRows(mergedCaptures, owner.id);
  return incoming;
}

module.exports = {
  MAX_DUPLICATE_RESOLUTIONS,
  captureOwnerId,
  captureIdentityKeys,
  captureStableIdentityKeys,
  dedupeCaptureRows,
  mergeWorkspaceCapturesForUser,
  mergeCaptureRecords,
  normalizeDuplicateResolutions,
  normalizeWorkspaceState,
  removeCompletedCaptureRows,
  scopeWorkspaceStateForUser,
  taskOwnerId
};
