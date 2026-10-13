const assert = require('assert');
const { parseCustomerLead } = require('../src/services/aiCustomerParser');

async function run() {
  const simple = await parseCustomerLead('姓名：张老师，手机：13800138000，微信号：zhanglaoshi88', { env: {} });
  assert.equal(simple.parsing.strategy, 'rule');
  assert.equal(simple.customer.name, '张老师');
  assert.equal(simple.customer.phone, '13800138000');
  assert.equal(simple.customer.wechat_id, 'zhanglaoshi88');

  let requested = false;
  const complex = await parseCustomerLead('王老师在山东做生涯规划，想合作，方便时联系', {
    env: { OPENAI_API_KEY: 'test-key', OPENAI_CUSTOMER_PARSER_MODEL: 'gpt-4o-mini' },
    fetchImpl: async () => {
      requested = true;
      return {
        ok: true,
        json: async () => ({ output_text: JSON.stringify({
          name: '王老师', phone: '', province: '山东省', city: '', identity: '生涯规划师', org_name: '',
          wechat_nickname: '', wechat_id: '', douyin_nickname: '', douyin_id: '', channel_account: '', official_account: '', remark: '有合作意向'
        }) })
      };
    }
  });
  assert.equal(requested, true);
  assert.equal(complex.parsing.strategy, 'ai');
  assert.equal(complex.customer.identity, '生涯规划师');

  const fallback = await parseCustomerLead('请加微咨询志愿填报服务', {
    env: { OPENAI_API_KEY: 'test-key' },
    fetchImpl: async () => { throw new Error('network unavailable'); }
  });
  assert.equal(fallback.parsing.strategy, 'rule_fallback');
  console.log('AI customer parser tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
