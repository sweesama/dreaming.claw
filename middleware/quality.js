// middleware/quality.js
// 职责：质量门——决定一条梦境是否值得上墙
// 当前策略：只做最宽松的结构校验（不能空、不能超长），其他全放行
// 以后要升级：在这里加语言检测、重复度、LLM 评分等；API 不变
//
// 为什么留这个占位？—— 产品决策是"筛选权在 skill 端"。但万一以后发现垃圾太多，
// 平台需要一道兜底，在这里加一层即可，无需改路由或客户端

const MAX_ENTRIES = 20;          // 一次最多 20 条（防暴刷）
const MAX_ENTRY_LENGTH = 2000;   // 单条最多 2000 字符
const MIN_ENTRY_LENGTH = 2;      // 单条至少 2 字符，过滤空白

// 简单 HTML 消毒：去除 <tag> 和 </tag>，防止 XSS
// 注意：这是"预防性"的，不是"允许富文本"的。如果以后要支持格式，需要换策略
function sanitizeEntry(text) {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')  // 移除 script 标签及内容
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')    // 移除 style 标签及内容
    .replace(/<[\/]?[^>]+>/g, '');                        // 移除所有 HTML 标签
}

function qualityGate(req, res, next) {
  const { entries } = req.body || {};

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'invalid-entries',
      message: 'entries must be a non-empty array of strings.',
    });
  }

  if (entries.length > MAX_ENTRIES) {
    return res.status(400).json({
      ok: false,
      error: 'too-many-entries',
      message: `entries length ${entries.length} exceeds max ${MAX_ENTRIES}.`,
    });
  }

  for (const [i, e] of entries.entries()) {
    if (typeof e !== 'string') {
      return res.status(400).json({ ok: false, error: 'entry-not-string', index: i });
    }
    const sanitized = sanitizeEntry(e);
    const len = sanitized.trim().length;
    if (len < MIN_ENTRY_LENGTH) {
      return res.status(400).json({ ok: false, error: 'entry-too-short', index: i });
    }
    if (len > MAX_ENTRY_LENGTH) {
      return res.status(400).json({ ok: false, error: 'entry-too-long', index: i });
    }
  }

  // 规范化：消毒 + trim 掉首尾空白，保留中间换行
  req.body.entries = entries.map((e) => sanitizeEntry(e).trim());

  next();
}

module.exports = { qualityGate };
