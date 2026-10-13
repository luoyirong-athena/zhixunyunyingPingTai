const express = require('express');
const rateLimit = require('express-rate-limit');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { parseCustomerLead } = require('../services/aiCustomerParser');

const router = express.Router();

router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);
router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.OPENAI_CUSTOMER_PARSER_RATE_LIMIT || 30),
  keyGenerator: (req) => `customer-parser:${req.user.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI 客户解析请求过于频繁，请稍后再试' }
}));

router.post('/parse', async (req, res, next) => {
  try {
    const result = await parseCustomerLead(req.body?.rawText);
    res.json(result);
  } catch (error) {
    if (/缺少客户线索|不能超过/.test(error.message)) return res.status(400).json({ error: error.message });
    next(error);
  }
});

module.exports = router;
