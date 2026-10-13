const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MAX_RAW_TEXT_LENGTH = 12000;

const CUSTOMER_FIELDS = [
  'name', 'phone', 'province', 'city', 'identity', 'org_name',
  'wechat_nickname', 'wechat_id', 'douyin_nickname', 'douyin_id',
  'channel_account', 'official_account', 'remark'
];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: CUSTOMER_FIELDS,
  properties: Object.fromEntries(CUSTOMER_FIELDS.map((field) => [field, { type: 'string' }]))
};

const SYSTEM_PROMPT = `你是 B 端客户线索信息提取助手。将用户提供的中文非结构化客户线索提取为 JSON。
只提取文本中明确出现或可直接判断的信息，不要猜测、补全或编造。
phone 只保留中国大陆 11 位手机号码；无法确认时为空字符串。
province 使用省级行政区全称，city 使用城市名称；无法确认时为空字符串。
identity 仅可使用：高考志愿规划师、教培机构老板、教培机构老师、高中老师、生涯规划师、留学机构、其他；未提及时为空字符串。
remark 仅保留未映射到其他字段、但可能影响跟进的原始信息，简洁概括。
所有字段必须存在，未知值使用空字符串。`;

function text(value) {
  return String(value || '').trim();
}

function firstMatch(source, expression) {
  const match = source.match(expression);
  return text(match?.[1]);
}

function normalizePhone(value) {
  const match = text(value).match(/(?<!\d)(1[3-9]\d{9})(?!\d)/);
  return match?.[1] || '';
}

function normalizeOutput(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const output = Object.fromEntries(CUSTOMER_FIELDS.map((field) => [field, text(raw[field])]));
  output.phone = normalizePhone(output.phone);
  return output;
}

function ruleParse(rawText) {
  const source = text(rawText);
  const phone = normalizePhone(source);
  const name = firstMatch(source, /(?:姓名|客户|联系人)[：:\s]*([\u4e00-\u9fa5]{2,12})/);
  const province = firstMatch(source, /(?:省份|地区|所在地)[：:\s]*([^\s，,。；;]{2,12}(?:省|市|自治区|特别行政区))/);
  const city = firstMatch(source, /(?:城市|地区|所在地)[：:\s]*([^\s，,。；;]{2,12}市?)/);
  const wechatId = firstMatch(source, /(?:微信号|微信|wx|v信)[：:\s]*([A-Za-z][A-Za-z0-9_-]{4,24})/i);
  const douyinId = firstMatch(source, /(?:抖音号|抖音)[：:\s]*([A-Za-z0-9_-]{3,40})/i);
  const orgName = firstMatch(source, /(?:机构|公司|学校|工作室|单位)[：:\s]*([^\n，,。；;]{2,50})/);
  const identity = firstMatch(source, /(?:身份|职业|角色)[：:\s]*(高考志愿规划师|教培机构老板|教培机构老师|高中老师|生涯规划师|留学机构|其他)/);

  return normalizeOutput({
    name,
    phone,
    province,
    city,
    identity,
    org_name: orgName,
    wechat_nickname: firstMatch(source, /(?:微信昵称|微信名)[：:\s]*([^\n，,。；;]{2,40})/),
    wechat_id: wechatId,
    douyin_nickname: firstMatch(source, /(?:抖音昵称|抖音名)[：:\s]*([^\n，,。；;]{2,40})/),
    douyin_id: douyinId,
    channel_account: firstMatch(source, /(?:视频号)[：:\s]*([^\n，,。；;]{2,40})/),
    official_account: firstMatch(source, /(?:公众号)[：:\s]*([^\n，,。；;]{2,40})/),
    remark: source
  });
}

function populatedCount(customer) {
  return CUSTOMER_FIELDS.filter((field) => field !== 'remark' && text(customer[field])).length;
}

function needsAi(rawText, customer) {
  const source = text(rawText);
  const hasContact = Boolean(customer.phone || customer.wechat_id || customer.douyin_id || customer.channel_account);
  const hasLabel = /(?:姓名|客户|联系人|微信|抖音|视频号|机构|学校|地区|省份|城市)[：:]/.test(source);
  const hasAmbiguity = /(?:加微|同微|v信|VX|wx|\+v|私聊|详情见主页)/i.test(source) || source.split(/\n|[。；;]/).filter(Boolean).length >= 3;
  return !hasContact || populatedCount(customer) < 3 || !hasLabel || hasAmbiguity;
}

function mergeWithRules(ruleCustomer, aiCustomer) {
  const ai = normalizeOutput(aiCustomer);
  const merged = { ...ruleCustomer };
  // A rule-derived value is treated as authoritative. The model only fills
  // gaps, keeping deterministic contact extraction ahead of probabilistic AI.
  CUSTOMER_FIELDS.forEach((field) => {
    if ((field === 'remark' || !merged[field]) && ai[field]) merged[field] = ai[field];
  });
  return merged;
}

function openAiConfig(env = process.env) {
  const apiKey = text(env.OPENAI_API_KEY);
  return {
    apiKey,
    baseUrl: text(env.OPENAI_BASE_URL || OPENAI_BASE_URL).replace(/\/$/, ''),
    model: text(env.OPENAI_CUSTOMER_PARSER_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini'),
    timeoutMs: Math.max(1000, Math.min(30000, Number(env.OPENAI_CUSTOMER_PARSER_TIMEOUT_MS) || 12000))
  };
}

async function requestOpenAi(rawText, config, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: SYSTEM_PROMPT }] },
          { role: 'user', content: [{ type: 'input_text', text: rawText }] }
        ],
        text: { format: { type: 'json_schema', name: 'customer_capture', strict: true, schema: OUTPUT_SCHEMA } }
      })
    });
    if (!response.ok) throw new Error(`OpenAI API ${response.status}`);
    const payload = await response.json();
    const outputText = text(payload.output_text);
    if (!outputText) throw new Error('OpenAI API returned no structured output');
    return JSON.parse(outputText);
  } finally {
    clearTimeout(timeout);
  }
}

async function parseCustomerLead(rawText, options = {}) {
  const source = text(rawText);
  if (!source) throw new Error('缺少客户线索文本');
  if (source.length > MAX_RAW_TEXT_LENGTH) throw new Error(`客户线索文本不能超过 ${MAX_RAW_TEXT_LENGTH} 个字符`);

  const ruleCustomer = ruleParse(source);
  const useAi = needsAi(source, ruleCustomer);
  if (!useAi) return { customer: ruleCustomer, parsing: { strategy: 'rule', reason: '规则结果完整', aiConfigured: Boolean(openAiConfig(options.env).apiKey) } };

  const config = openAiConfig(options.env);
  if (!config.apiKey) {
    return { customer: ruleCustomer, parsing: { strategy: 'rule_fallback', reason: '复杂线索，但未配置 OPENAI_API_KEY', aiConfigured: false } };
  }

  try {
    const aiCustomer = await requestOpenAi(source, config, options.fetchImpl);
    return { customer: mergeWithRules(ruleCustomer, aiCustomer), parsing: { strategy: 'ai', reason: '规则结果存在缺失或歧义', aiConfigured: true, model: config.model } };
  } catch (error) {
    console.warn('[AI Customer Parser] OpenAI fallback', error.message);
    return { customer: ruleCustomer, parsing: { strategy: 'rule_fallback', reason: 'OpenAI 解析失败，已使用规则结果', aiConfigured: true } };
  }
}

module.exports = { MAX_RAW_TEXT_LENGTH, CUSTOMER_FIELDS, ruleParse, needsAi, parseCustomerLead };
