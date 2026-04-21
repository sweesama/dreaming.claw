// server.js —— 入口（本地 dev + Vercel serverless 共用）
// 职责：加载环境变量、装配 Express、挂路由；
//   - 本地：`node server.js` → 调 app.listen()
//   - Vercel：api/index.js require 本文件，取出 app 作为 handler
// 设计：整个文件一次性构造 app 并导出；listen 仅在直接执行时触发

require('dotenv').config();

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

const apiRouter = require('./routes/dreams');
const pagesRouter = require('./routes/pages');
const ogRouter = require('./routes/og');

const app = express();

// 信任代理：Vercel / Cloudflare / Railway 都是反代，后面的都要 trust
// 'trust proxy = true' 全信任；如果担心伪造可以改成具体 CIDR
app.set('trust proxy', true);

// ---------- 基础安全响应头 ----------
// CSP：允许同源脚本 + importmap 里用到的 esm.sh / unpkg（Three.js）
// Google Fonts 放行 fonts.googleapis.com（CSS） & fonts.gstatic.com（字体文件）
// 'unsafe-inline' 用于 SSR 注入的 <script type="application/json"> 与内联 style
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://unpkg.com https://esm.sh",
      "script-src-elem 'self' 'unsafe-inline' https://unpkg.com https://esm.sh",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// 解析 JSON body（限制大小，防滥用）
app.use(express.json({ limit: '64kb' }));

// 静态资源：CSS / 前端 JS / favicon
app.use('/static', express.static(path.join(__dirname, 'public', 'static'), {
  maxAge: '1d',
}));

// ---------- 速率限制 ----------
// 写接口（POST /api/dreams 和 resonance）的限流器：更严
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 分钟窗口
  limit: 20,                  // 每 IP 每分钟最多 20 次写请求
  standardHeaders: 'draft-7', // 返回 RateLimit-* header
  legacyHeaders: false,
  message: { ok: false, error: 'rate-limited', message: 'too many requests, slow down.' },
});

// 只给 /api 路由下的写操作用。GET 不限，方便爬虫 / SSR
app.use('/api', (req, res, next) => {
  if (req.method === 'POST') return writeLimiter(req, res, next);
  next();
});

// API
app.use('/api', apiRouter);

// OG 图片（分享预览）
app.use('/og', ogRouter);

// 健康检查
app.get('/healthz', (req, res) => res.json({ ok: true }));

// 页面（SSR，包含 /robots.txt, /sitemap.xml, /feed.xml, /about）
app.use('/', pagesRouter);

// 404 兜底（只会命中未匹配的路径）
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not-found', path: req.path });
});

// 错误兜底
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ ok: false, error: 'internal-error' });
});

// 导出 app：Vercel api/index.js 会 require 本文件并使用这个 app 作为 handler
module.exports = app;

// 仅当直接 `node server.js` 运行时监听端口（本地 dev）
// Vercel 里 server.js 被 require，require.main !== module，不会 listen
if (require.main === module) {
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  app.listen(PORT, () => {
    console.log(`\n  🌙  ${process.env.SITE_NAME || 'dreaming.claw'} is awake on http://localhost:${PORT}\n`);
    if (!process.env.AGENT_KEY && !process.env.TURSO_DATABASE_URL) {
      console.warn('  ⚠️  AGENT_KEY not set — POST /api/dreams will be refused.');
      console.warn('  ⚠️  TURSO_DATABASE_URL not set — using local file:./dreams.db\n');
    }
  });
}
