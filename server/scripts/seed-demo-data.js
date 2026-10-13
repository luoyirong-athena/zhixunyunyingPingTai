'use strict';

const { initDatabase, getDatabase, DEFAULT_TEAM_CODE } = require('../src/config/database');
const { initAdminUser } = require('../src/utils/initAdmin');

const demoStatuses = [
  ['新客户', '#315efb'], ['已联系', '#0891b2'], ['已加微信', '#7c3aed'], ['高意向', '#f59e0b'],
  ['试用中', '#19a974'], ['已付费', '#ef4444'], ['待维护', '#64748b'], ['已流失', '#ec4899'],
].map(([name, color], index) => ({ id: `demo-status-${index + 1}`, name, color, autoTask: ['试用中', '已付费'].includes(name) }));

const customerSeed = [
  ['林老师', '河南', '郑州', '高考志愿规划师', '高意向', '19900000001', '郑州启航教育工作室', 'lin_demo_01', '林老师说升学', 'demo_dy_001', '2.8万', '关注机构合作方案'],
  ['周老师', '山东', '济南', '教育机构', '已付费', '19900000002', '济南新航道教育', 'zhou_demo_02', '周老师聊志愿', 'demo_dy_002', '1.6万', '已完成产品试用'],
  ['陈老师', '四川', '成都', '生涯规划师', '已联系', '19900000003', '成都远见生涯中心', 'chen_demo_03', '陈老师谈生涯', 'demo_dy_003', '8600', '等待补充机构规模'],
  ['赵校长', '河北', '石家庄', '学校', '新客户', '', '石家庄向阳中学', '', '向阳升学服务', 'demo_dy_004', '4200', '待首次联系'],
  ['王老师', '广东', '广州', '教育机构', '试用中', '19900000005', '广州思远教育', 'wang_demo_05', '王老师讲志愿', 'demo_dy_005', '3.1万', '本周需要回访'],
  ['刘老师', '江苏', '苏州', '志愿规划师', '待维护', '19900000006', '苏州知行工作室', 'liu_demo_06', '刘老师说高考', 'demo_dy_006', '7200', '上月沟通后暂未回复'],
];

const customers = customerSeed.map((row, index) => {
  const [name, province, city, identity, sales_status, phone, org_name, wechat_id, douyin_nickname, douyin_id, douyin_followers, remark] = row;
  return {
    id: `demo-customer-${String(index + 1).padStart(3, '0')}`, name, province, city, identity, sales_status, phone, org_name,
    wechat_id, douyin_nickname, douyin_id, douyin_followers, remark, wechat_nickname: wechat_id ? `${name}升学规划` : '',
    approval: '正式', source: '演示数据', createdAt: `2026-10-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
    updatedAt: `2026-10-${String(8 + index).padStart(2, '0')}T10:30:00.000Z`, created_by_user_id: 1,
    created_by_username: 'demo', createdBy: '演示管理员', userId: 1, statusHistory: [],
  };
});

const state = {
  version: 2, dataVersionName: 'demo-v1', statuses: demoStatuses,
  taskTypes: ['电话联系', '微信沟通', '抖音沟通', '试用回访', '付费回访', '客户反馈处理', '资料整理', '运营计划'],
  customers,
  tasks: [
    { id: 'demo-task-001', title: '回访试用效果', description: '确认王老师的试用反馈，并介绍机构合作方案。', type: '试用回访', status: '待办', priority: '高', dueDate: '2026-10-14', customerId: 'demo-customer-005', createdAt: '2026-10-12T08:30:00.000Z', created_by_user_id: 1, created_by_username: 'demo', createdBy: '演示管理员' },
    { id: 'demo-task-002', title: '补充客户机构信息', description: '确认陈老师所在机构的服务规模。', type: '电话联系', status: '进行中', priority: '普通', dueDate: '2026-10-15', customerId: 'demo-customer-003', createdAt: '2026-10-11T08:30:00.000Z', created_by_user_id: 1, created_by_username: 'demo', createdBy: '演示管理员' },
  ],
  feedback: [{ id: 'demo-feedback-001', customerId: 'demo-customer-002', type: '功能建议', content: '希望增加区域客户转化对比。', priority: '中', status: '待处理', createdAt: '2026-10-12T06:00:00.000Z', updatedAt: '2026-10-12T06:00:00.000Z' }],
  chats: [{ id: 'demo-chat-001', customerId: 'demo-customer-001', fileName: '林老师沟通记录.txt', messages: [{ role: '客户', content: '想了解机构合作模式。', at: '2026-10-11T08:00:00.000Z' }, { role: '我方', content: '可以，我先发您一份产品资料。', at: '2026-10-11T08:10:00.000Z' }], createdAt: '2026-10-11T08:10:00.000Z', updatedAt: '2026-10-11T08:10:00.000Z' }],
  captures: [{ id: 'demo-capture-001', sessionId: 'demo-session', platform: 'douyin', province: '湖北', city: '武汉', identity: '高考志愿规划师', name: '演示待确认客户', douyin_nickname: '武汉升学规划', douyin_id: 'demo_capture_001', phone: '', org_name: '', remark: '这是一条待确认演示数据', confirmed: false, createdAt: '2026-10-13T07:00:00.000Z', created_by_user_id: 1, created_by_username: 'demo', createdBy: '演示管理员' }],
  capturePromotionTombstones: [], otherSituationRecords: [], duplicateResolutions: [], materials: [], logs: [],
  scripts: [{ id: 'demo-script-001', title: '首次联系话术', category: '首次沟通', scene: '新客户', content: '您好，了解到您主要负责升学规划，想和您简单介绍一下我们的机构合作方案。', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }],
  experiences: [{ id: 'demo-experience-001', title: '高意向客户判断要点', category: '客户判断', scene: '客户跟进', content: '客户主动询问合作价格、交付方式和试用流程时，可以标记为高意向，并创建后续回访任务。', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }],
  settings: { systemName: '志询运营', api: { provider: '', baseUrl: '', apiKey: '', model: '', enabled: false }, taskAutomation: true, regionMode: '大区', identities: ['高考志愿规划师', '生涯规划师', '教育机构', '学校', '教师', '个人客户', '其他'], managedWechatAccounts: [], feedbackTypes: ['产品问题', '数据问题', '体验问题', '功能建议', '服务问题', '其他'], knowledgeView: 'card', materialCategories: ['资料文件', '产品资料', '培训资料', '运营素材'], experienceCategories: [], scriptCategories: [] },
};

initDatabase();
initAdminUser();
const db = getDatabase();
const team = db.prepare('SELECT id FROM teams WHERE code = ?').get(DEFAULT_TEAM_CODE);
if (!team) throw new Error('演示团队初始化失败');
db.prepare(`UPDATE workspace_states SET state_json = ?, version = 1, initialized_by_user_id = 1, updated_by_user_id = 1, updated_at = CURRENT_TIMESTAMP WHERE team_id = ?`).run(JSON.stringify(state), team.id);
console.log(`[SEED] 已写入虚构演示数据：${customers.length} 位客户、${state.tasks.length} 条任务、${state.feedback.length} 条反馈`);
