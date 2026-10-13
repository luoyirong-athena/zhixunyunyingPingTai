// Express 路由：替代 Netlify ocr.js 函数
// 1) OCR 模式：body.image 存在时，调用能看图的 AI 提取客户信息
// 2) Chat 模式：body.messages 存在时，做普通对话补全（经验库 AI 总结）
// Key 从环境变量读取，不暴露给前端访客

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authRequired } = require('../middleware/auth');
const { safeError } = require('../utils/errorHandler');
const router = express.Router();

router.use(authRequired);
router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.OCR_USER_RATE_LIMIT || 30),
  keyGenerator: req => `ocr-user:${req.user.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI识别请求过于频繁，请稍后再试' },
}));

const SYSTEM_PROMPT = `你是高考志愿规划师客户信息提取助手。用户会发来一张图片（可能是抖音/视频号/公众号主页截图、名片、聊天记录、宣传图）。请从中尽量提取客户信息，并以 JSON 返回，字段如下：
{
  "name": "姓名或老师称呼，如 张老师",
  "phone": "手机号（仅数字，没有则留空字符串）",
  "wechatNickname": "微信昵称",
  "wechatId": "微信号",
  "douyinNickname": "抖音昵称",
  "douyinId": "抖音号",
  "videoAccount": "视频号",
  "publicAccount": "公众号",
  "city": "城市",
  "province": "省份",
  "orgName": "机构名称",
  "identity": "从[高考志愿规划师,教培机构老板,教培机构老师,高中老师,生涯规划师,留学机构,其他]中选最合适的一个",
  "salesStatus": "销售状态：从[新客户,已联系,已加微信,已电联,已抖音私信,高意向,试用中,已付费,待维护,已流失]中选最合适的",
  "remark": "对图片内容的简要备注"
}
只输出 JSON，不要任何解释，不要 markdown 代码块。`;

// POST 处理（兼容 Netlify Functions 调用方式）
router.post('/', async (req, res) => {
  // 也支持通过路径挂载时匹配空路径
  await handleRequest(req, res);
});

router.post('/ocr', async (req, res) => {
  await handleRequest(req, res);
});

async function handleRequest(req, res) {
  const body = req.body || {};

  const apiKey = process.env.VISION_API_KEY || process.env.OCR_API_KEY;
  const base = process.env.VISION_API_BASE || process.env.OCR_API_ENDPOINT || 'https://api.openai.com/v1';
  const configuredModel = process.env.VISION_MODEL || process.env.OCR_MODEL || 'gpt-4o-mini';
  const allowedModels = new Set(String(process.env.OCR_ALLOWED_MODELS || configuredModel).split(',').map(item => item.trim()).filter(Boolean));
  const model = body.model || configuredModel;
  if (!allowedModels.has(model)) return res.status(400).json({ error: '不支持的 AI 模型' });

  if (!apiKey) {
    return res.status(400).json({
      error: '未配置 VISION_API_KEY 或 OCR_API_KEY 环境变量（请在 .env 文件中添加）',
    });
  }

  // —— Chat 模式（AI 总结 / 通用对话）——
  if (body.messages && Array.isArray(body.messages)) {
    if (body.messages.length > 50 || JSON.stringify(body.messages).length > 100 * 1024) {
      return res.status(413).json({ error: '对话内容过大，请分段提交' });
    }
    const temperature = body.temperature === undefined ? 0.4 : Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return res.status(400).json({ error: 'temperature 参数不正确' });
    }
    try {
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: body.messages, temperature }),
      });

      if (!resp.ok) {
        const txt = await resp.text();
        console.error(`[OCR] AI API error ${resp.status}: ${txt.slice(0, 300)}`);
        return res.status(502).json({ error: 'AI 服务暂时不可用，请稍后重试' });
      }

      const data = await resp.json();
      return res.json(data);
    } catch (e) {
      return safeError(e, res);
    }
  }

  // —— OCR 模式（图片识别）——
  const image = body.image;
  if (!image) {
    return res.status(400).json({ error: '缺少 image 或 messages' });
  }

  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: '请提取图片中的客户信息' },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error(`[OCR] Vision API error ${resp.status}: ${txt.slice(0, 300)}`);
      return res.status(502).json({ error: '视觉识别服务暂时不可用，请稍后重试' });
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(502).json({ error: 'AI 返回的不是合法 JSON' });
    }

    return res.json({ customer: parsed });
  } catch (e) {
    return safeError(e, res);
  }
}

module.exports = router;
