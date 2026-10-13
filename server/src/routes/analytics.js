const express = require('express');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { dateKey, isOfficialCustomer, workspaceCollections } = require('../services/workspaceReadModel');

const router = express.Router();
router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);

const REGIONS = {
  华北: ['北京', '天津', '河北', '山西', '内蒙古'],
  东北: ['辽宁', '吉林', '黑龙江'],
  华东: ['上海', '江苏', '浙江', '安徽', '福建', '江西', '山东'],
  华中: ['河南', '湖北', '湖南'],
  华南: ['广东', '广西', '海南'],
  西南: ['重庆', '四川', '贵州', '云南', '西藏'],
  西北: ['陕西', '甘肃', '青海', '宁夏', '新疆'],
  港澳台: ['香港', '澳门', '台湾'],
};

function activeCollections(req) {
  return workspaceCollections(getDatabase(), req.team.id);
}

function isPendingTask(task) {
  return ['待办', '进行中', '已逾期', '待处理'].includes(String(task?.status || ''));
}

function daysAgo(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date;
}

function countByDate(items, field, days) {
  const since = daysAgo(days - 1).getTime();
  const counts = new Map();
  for (const item of items) {
    const raw = field === 'createdAt'
      ? (item?.createdAt || item?.created_at)
      : (item?.updatedAt || item?.updated_at);
    const value = new Date(raw || '').getTime();
    if (!Number.isNaN(value) && value >= since) {
      const key = dateKey(raw);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
}

router.get('/dashboard', (req, res) => {
  const { customers, tasks, feedback } = activeCollections(req);
  const official = customers.filter(isOfficialCustomer);
  const pendingCustomers = customers.filter(customer => String(customer?.approval || customer?.approval_status || '') === '待确认').length;
  const byStatus = new Map();
  official.forEach(customer => {
    const name = String(customer?.sales_status || customer?.salesStatus || '');
    if (name) byStatus.set(name, (byStatus.get(name) || 0) + 1);
  });
  const bySalesStatus = [...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  const statusMap = Object.fromEntries(bySalesStatus.map((row) => [row.name, row.count]));
  const today = dateKey(new Date());
  res.json({
    total: official.length,
    todayNew: official.filter(customer => dateKey(customer.createdAt || customer.created_at) === today).length,
    pendingCustomers,
    trialCount: statusMap['试用中'] || 0,
    highIntentCount: statusMap['高意向'] || 0,
    paidCount: statusMap['已付费'] || 0,
    pendingTasks: tasks.filter(isPendingTask).length,
    pendingFeedback: feedback.filter(item => String(item?.status || '') === '待处理').length,
    weekConversions: official.filter(customer => String(customer?.sales_status || customer?.salesStatus || '') === '已付费'
      && new Date(customer.updatedAt || customer.updated_at || '').getTime() >= daysAgo(6).getTime()).length,
    bySalesStatus,
  });
});

router.get('/funnel', (req, res) => {
  const { customers, statuses } = activeCollections(req);
  const configured = statuses.filter(status => Number(status?.is_enabled ?? 1) !== 0 && Number(status?.is_funnel ?? status?.isFunnel ?? 0) === 1)
    .sort((a, b) => Number(a.sort_order ?? a.sortOrder ?? 0) - Number(b.sort_order ?? b.sortOrder ?? 0))
    .map(status => status.name).filter(Boolean);
  const stages = configured.length ? configured : ['已联系', '已加微信', '高意向', '试用中', '已付费'];
  const official = customers.filter(isOfficialCustomer);
  res.json({ funnel: stages.map(stage => ({ stage, count: official.filter(customer => (customer.sales_status || customer.salesStatus) === stage).length })) });
});

router.get('/regional', (req, res) => {
  const { customers } = activeCollections(req);
  const provinceMap = new Map();
  customers.filter(isOfficialCustomer).forEach(customer => {
    const province = String(customer?.province || '').trim();
    if (province) provinceMap.set(province, (provinceMap.get(province) || 0) + 1);
  });
  const provinces = [...provinceMap.entries()].sort((a, b) => b[1] - a[1]).map(([province, count]) => ({ province, count }));
  const regions = Object.fromEntries(Object.keys(REGIONS).map((name) => [name, 0]));
  for (const row of provinces) {
    const region = Object.entries(REGIONS).find(([, values]) => values.includes(row.province))?.[0];
    if (region) regions[region] += row.count;
  }
  res.json({ regions, provinces, total: provinces.reduce((sum, row) => sum + row.count, 0) });
});

router.get('/trends', (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const { customers } = activeCollections(req);
  const official = customers.filter(isOfficialCustomer);
  const dailyNew = countByDate(official, 'createdAt', days);
  const dailyPaid = countByDate(official.filter(customer => (customer.sales_status || customer.salesStatus) === '已付费'), 'updatedAt', days);
  res.json({ dailyNew, dailyPaid });
});

router.get('/summary', (req, res) => {
  const { customers, tasks, feedback, experiences, chats } = activeCollections(req);
  res.json({
    customers: customers.filter(isOfficialCustomer).length,
    pendingCustomers: customers.filter(customer => String(customer?.approval || customer?.approval_status || '') === '待确认').length,
    tasks: tasks.length,
    feedback: feedback.length,
    experiences: experiences.length,
    chatRecords: chats.length,
  });
});

module.exports = router;
