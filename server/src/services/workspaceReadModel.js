'use strict';

const { normalizeWorkspaceState } = require('./workspaceState');

function readWorkspaceState(db, teamId) {
  const row = db.prepare('SELECT state_json, version FROM workspace_states WHERE team_id = ?').get(teamId);
  let state = {};
  try { state = JSON.parse(row?.state_json || '{}'); } catch (_) {}
  return { state: normalizeWorkspaceState(state), version: Number(row?.version || 0) };
}

function isDeleted(item) {
  return Boolean(item?.deletedAt || item?.deleted_at || item?.isDeleted || item?.is_deleted);
}

function isOfficialCustomer(customer) {
  return String(customer?.approval || customer?.approval_status || '正式') !== '待确认'
    && !isDeleted(customer);
}

function dateKey(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function workspaceCollections(db, teamId) {
  const { state, version } = readWorkspaceState(db, teamId);
  return {
    state,
    version,
    customers: Array.isArray(state.customers) ? state.customers.filter(item => !isDeleted(item)) : [],
    tasks: Array.isArray(state.tasks) ? state.tasks.filter(item => !isDeleted(item)) : [],
    feedback: Array.isArray(state.feedback) ? state.feedback.filter(item => !isDeleted(item)) : [],
    experiences: Array.isArray(state.experiences) ? state.experiences.filter(item => !isDeleted(item)) : [],
    chats: Array.isArray(state.chats) ? state.chats.filter(item => !isDeleted(item)) : [],
    statuses: Array.isArray(state.statuses) ? state.statuses : []
  };
}

module.exports = {
  dateKey,
  isDeleted,
  isOfficialCustomer,
  readWorkspaceState,
  workspaceCollections
};
