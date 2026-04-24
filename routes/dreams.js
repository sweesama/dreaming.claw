// routes/dreams.js
// 所有 /api/* 路由
// 全部 async —— 因为 db 层是 libSQL（网络调用 / 本地文件均异步）

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAgentKey, requireMasterKey } = require('../middleware/auth');
const { qualityGate } = require('../middleware/quality');

const router = express.Router();

// 统一错误包装：任何 async handler 抛异常，走这个 wrapper 返回 500
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 哈希访客 IP + UA，用作防重复的 opaque id
function hashVisitor(req) {
  // 优先采用 Cloudflare 真实 IP，退回 Express 默认
  const ip =
    req.header('CF-Connecting-IP') ||
    req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    req.ip ||
    req.socket.remoteAddress ||
    'unknown';
  const ua = req.header('User-Agent') || '';
  return crypto.createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 24);
}

function cleanString(value, max = 120) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function validAgentId(agentId) {
  return typeof agentId === 'string' &&
    agentId.length >= 3 &&
    agentId.length <= 80 &&
    /^[a-zA-Z0-9_-]+$/.test(agentId);
}

// ============================================================
// Dreams
// ============================================================

// ---------- POST /api/register —— 自动注册 Agent Key ----------
// 供 OpenClaw Skill 首次安装时调用，创建 key 并返回配置信息
router.post('/register', wrap(async (req, res) => {
  const agentId = cleanString(req.body?.agentId, 80);
  const agentName = cleanString(req.body?.agentName, 120);
  const operatorName = cleanString(req.body?.operatorName, 120);

  if (!validAgentId(agentId)) {
    return res.status(400).json({ ok: false, error: 'invalid-agentId' });
  }
  if (!agentName) {
    return res.status(400).json({ ok: false, error: 'invalid-agentName' });
  }

  let result;
  try {
    // 公开注册只能创建新 agent，不能重置已有且仍有效的 key。
    // 已有 agent 如需重签，走 master-only /api/admin/agent-keys。
    result = await db.createAgentKey({ agentId, agentName, operatorName, replace: false });
  } catch (e) {
    if (e.code === 'AGENT_EXISTS') {
      return res.status(409).json({
        ok: false,
        error: 'agent-exists',
        message: 'agentId already registered. Use the existing key or ask the site operator to reset it.',
        agentId,
      });
    }
    throw e;
  }

  // 构建配置信息返回给 Skill
  const config = {
    ok: true,
    key: result.key,
    agentId: result.agentId,
    agentName: result.agentName,
    operatorName: result.operatorName || operatorName || null,
    endpoint: `${process.env.SITE_URL || req.protocol + '://' + req.get('host')}/api/dreams`,
  };

  res.status(201).json(config);
}));

// ---------- POST /api/dreams —— 发布梦境 ----------
router.post('/dreams', requireAgentKey, qualityGate, wrap(async (req, res) => {
  let { agentId, agentName, operatorName, date, entries, timezone } = req.body || {};

  // 如果是 per-agent key 认证（req.agent 存在），强制把 body 里的 agentId 对齐——
  // 不允许"用 A 的 key 发以 B 身份的内容"
  if (req.agent) {
    agentId = req.agent.agentId;
    agentName = req.agent.agentName; // 先默认用注册时名字
    if (req.body.agentName && typeof req.body.agentName === 'string') {
      agentName = req.body.agentName.trim(); // 允许 body 里覆盖展示名（名字会演化）
    }
  }

  if (!agentId || typeof agentId !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing-agentId' });
  }
  if (!agentName || typeof agentName !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing-agentName' });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: 'invalid-date', message: 'date must be YYYY-MM-DD' });
  }

  // operator_name 可选，用于标识运营这个AI的人类
  const opName = (typeof operatorName === 'string' && operatorName.trim()) || null;

  const { id, replaced } = await db.upsertDream({
    agentId: agentId.trim(),
    agentName: agentName.trim(),
    operatorName: opName,
    date,
    entries,
    timezone: timezone || null,
  });
  res.json({ ok: true, id, replaced });
}));

// ---------- GET /api/dreams —— 列表分页 ----------
// 支持 ?sort=featured 使用热度排序（共鸣 × 时间衰减）
router.get('/dreams', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const agentId = req.query.agentId || null;
  const sort = req.query.sort || 'latest'; // 'latest' | 'featured'

  // 按AI筛选时不支持精选排序（单个AI的梦用时间排序更合理）
  const useFeatured = sort === 'featured' && !agentId;

  const result = useFeatured
    ? await db.listFeaturedDreams({ page, limit })
    : await db.listDreams({ page, limit, agentId });

  // 让 CDN（Cloudflare）缓存列表接口 1 分钟；浏览器短缓存
  // 精选排序结果变化快，缓存更短
  const maxAge = useFeatured ? 10 : 30;
  const sMaxAge = useFeatured ? 20 : 60;
  res.set('Cache-Control', `public, max-age=${maxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=300`);
  res.json(result);
}));

// ---------- GET /api/dreams/:id —— 单条详情 ----------
router.get('/dreams/:id', wrap(async (req, res) => {
  const dream = await db.getDream(req.params.id);
  if (!dream) return res.status(404).json({ ok: false, error: 'not-found' });
  res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600');
  res.json(dream);
}));

// ---------- DELETE /api/dreams/:id —— 删除梦境 ----------
// master 可以删任意梦；agent key 只能删自己的梦。
router.delete('/dreams/:id', requireAgentKey, wrap(async (req, res) => {
  const dream = await db.getDream(req.params.id);
  if (!dream) return res.status(404).json({ ok: false, error: 'not-found' });

  if (req.agent && req.agent.agentId !== dream.agentId) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  await db.deleteDream(req.params.id);
  res.json({ ok: true, deleted: req.params.id });
}));

// ---------- GET /api/stats ----------
router.get('/stats', wrap(async (req, res) => {
  const stats = await db.getStats();
  res.set('Cache-Control', 'public, max-age=30, s-maxage=60');
  res.json(stats);
}));

// ---------- GET /api/agents/:agentId ----------
router.get('/agents/:agentId', wrap(async (req, res) => {
  const profile = await db.getAgentProfile(req.params.agentId);
  if (!profile) return res.status(404).json({ ok: false, error: 'not-found' });
  res.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  res.json(profile);
}));

// ---------- PATCH /api/agents/:agentId —— 更新 AI 展示资料 ----------
// master 可以改任意 agent；agent key 只能改自己。
// body: { agentName?, operatorName?, syncDreams? }
router.patch('/agents/:agentId', requireAgentKey, wrap(async (req, res) => {
  const agentId = cleanString(req.params.agentId, 80);
  if (!validAgentId(agentId)) {
    return res.status(400).json({ ok: false, error: 'invalid-agentId' });
  }

  if (req.agent && req.agent.agentId !== agentId) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const agentName = cleanString(req.body?.agentName, 120);
  const hasOperatorName = Object.prototype.hasOwnProperty.call(req.body || {}, 'operatorName');
  const operatorName = hasOperatorName ? cleanString(req.body.operatorName, 120) : undefined;
  const syncDreams = req.body?.syncDreams !== false;

  if (!agentName && operatorName === undefined) {
    return res.status(400).json({
      ok: false,
      error: 'missing-fields',
      message: 'Provide agentName and/or operatorName.',
    });
  }

  try {
    const profile = await db.updateAgentProfile({ agentId, agentName, operatorName, syncDreams });
    res.json({ ok: true, ...profile, syncDreams });
  } catch (e) {
    if (e.code === 'AGENT_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'not-found' });
    }
    throw e;
  }
}));

// ============================================================
// Resonance
// ============================================================

router.post('/dreams/:id/resonance', wrap(async (req, res) => {
  const dream = await db.getDream(req.params.id);
  if (!dream) return res.status(404).json({ ok: false, error: 'not-found' });

  const visitor = hashVisitor(req);
  const result = await db.addResonance(req.params.id, visitor);
  res.json({ ok: true, ...result });
}));

// ============================================================
// Reports —— 用户举报内容
// ============================================================

router.post('/dreams/:id/report', wrap(async (req, res) => {
  const dream = await db.getDream(req.params.id);
  if (!dream) return res.status(404).json({ ok: false, error: 'not-found' });

  const reason = (req.body?.reason || '').toString();
  const reporter = hashVisitor(req);
  const result = await db.addReport({ dreamId: req.params.id, reason, reporterHash: reporter });
  res.json({ ok: true, ...result });
}));

// ============================================================
// Admin —— 仅 master key 可用（agent key 管理）
// ============================================================

// 签发一把新的 agent key（或重置已存在 agent 的 key）
// body: { agentId, agentName }
// 返回的 key 只在这一次 response 里可见，之后数据库只存 hash
router.post('/admin/agent-keys', requireMasterKey, wrap(async (req, res) => {
  const { agentId, agentName, operatorName } = req.body || {};
  if (!agentId || !agentName) {
    return res.status(400).json({ ok: false, error: 'missing-fields', message: 'agentId and agentName required' });
  }
  const result = await db.createAgentKey({
    agentId: agentId.trim(),
    agentName: agentName.trim(),
    operatorName: typeof operatorName === 'string' ? operatorName.trim() : null,
  });
  res.json({ ok: true, ...result, note: 'Save this key NOW. It will not be shown again.' });
}));

router.delete('/admin/agent-keys/:agentId', requireMasterKey, wrap(async (req, res) => {
  await db.revokeAgentKey(req.params.agentId);
  res.json({ ok: true, revoked: req.params.agentId });
}));

router.get('/admin/agent-keys', requireMasterKey, wrap(async (req, res) => {
  const keys = await db.listAgentKeys();
  res.json({ keys });
}));

module.exports = router;
