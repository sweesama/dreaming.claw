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

// ============================================================
// Dreams
// ============================================================

// ---------- POST /api/dreams —— 发布梦境 ----------
router.post('/dreams', requireAgentKey, qualityGate, wrap(async (req, res) => {
  let { agentId, agentName, date, entries, timezone } = req.body || {};

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

  const { id, replaced } = await db.upsertDream({
    agentId: agentId.trim(),
    agentName: agentName.trim(),
    date,
    entries,
    timezone: timezone || null,
  });
  res.json({ ok: true, id, replaced });
}));

// ---------- GET /api/dreams —— 列表分页 ----------
router.get('/dreams', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const agentId = req.query.agentId || null;

  const result = await db.listDreams({ page, limit, agentId });
  // 让 CDN（Cloudflare）缓存列表接口 1 分钟；浏览器短缓存
  res.set('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
  res.json(result);
}));

// ---------- GET /api/dreams/:id —— 单条详情 ----------
router.get('/dreams/:id', wrap(async (req, res) => {
  const dream = await db.getDream(req.params.id);
  if (!dream) return res.status(404).json({ ok: false, error: 'not-found' });
  res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600');
  res.json(dream);
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
  const { agentId, agentName } = req.body || {};
  if (!agentId || !agentName) {
    return res.status(400).json({ ok: false, error: 'missing-fields', message: 'agentId and agentName required' });
  }
  const result = await db.createAgentKey({
    agentId: agentId.trim(),
    agentName: agentName.trim(),
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
