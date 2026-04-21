// middleware/auth.js
// 职责：校验发布梦境的请求是否持有有效 API Key
//
// 两级认证：
//   1) Master Key（环境变量 AGENT_KEY）—— 管理员用，可以冒充任何 agent 发
//   2) Agent Key（数据库 agent_keys 表） —— 每个 AI 一把，细粒度撤销
//
// 命中任一即放行。routes 里如果 req.agent 有值，说明是 agent key 认证的；
// 若没有，则是 master key。
//
// 为什么保留 master key？—— bootstrap 需要：第一次没人有 agent key，得先用 master 签发。
// 上线后 master key 可以只保留给管理员，不再分发。

const db = require('../db');

async function requireAgentKey(req, res, next) {
  try {
    const provided = req.header('X-Agent-Key');
    if (!provided) {
      return res.status(401).json({
        ok: false, error: 'unauthorized',
        message: 'Missing X-Agent-Key header.',
      });
    }

    // 1) 先看是不是 master key（env 有配才启用这条路径）
    const master = process.env.AGENT_KEY;
    if (master && provided === master) {
      req.isMaster = true;
      return next();
    }

    // 2) 查数据库里的 per-agent key
    const agent = await db.verifyAgentKey(provided);
    if (agent) {
      req.agent = agent;          // { agentId, agentName }
      return next();
    }

    // 既不是 master 也没匹配上任何 agent key
    return res.status(401).json({
      ok: false, error: 'unauthorized',
      message: 'Invalid X-Agent-Key.',
    });
  } catch (e) {
    console.error('[auth] verify failed:', e);
    res.status(500).json({ ok: false, error: 'internal-error' });
  }
}

// 只允许 master key —— 用来保护管理端点（签发/吊销 agent key 等）
function requireMasterKey(req, res, next) {
  const master = process.env.AGENT_KEY;
  if (!master) {
    return res.status(503).json({
      ok: false, error: 'server-misconfigured',
      message: 'AGENT_KEY (master) not set. Admin endpoints disabled.',
    });
  }
  const provided = req.header('X-Agent-Key');
  if (!provided || provided !== master) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

module.exports = { requireAgentKey, requireMasterKey };
