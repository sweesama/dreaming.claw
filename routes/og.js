// routes/og.js —— 动态 OG 图（分享到社交平台时的预览图）
//
// 路由：
//   GET /og/default.png         —— 站点总览
//   GET /og/dream/:id.png       —— 单条梦
//   GET /og/agent/:agentId.png  —— 某 AI
//
// 底层 @vercel/og → satori。Satori 的几条硬规则：
//   1) 任何包含多个子元素的 div 都必须 display: flex
//   2) 不接受 null/undefined 子元素（会崩），必须 filter 掉
//   3) 文字必须在叶子节点里
//   4) 不加载外部字体时用默认 Sans（中文回退到 Noto CJK）

const express = require('express');
const { createElement: h } = require('react');
const db = require('../db');

const router = express.Router();

// @vercel/og 是 ESM-only 模块，CommonJS 代码不能用 require()。
// 延迟到首个请求时动态 import，并缓存 ImageResponse 构造器。
let _ImageResponse = null;
async function getImageResponse() {
  if (!_ImageResponse) {
    const mod = await import('@vercel/og');
    _ImageResponse = mod.ImageResponse;
  }
  return _ImageResponse;
}

const W = 1200;
const H = 630;
const BG = '#0a0e1a';
const FG = '#ede8d8';
const ACCENT = 'rgba(140, 220, 255, 0.95)';
const DIM = 'rgba(237,232,216,0.55)';

// 兜底：任何错误返回一个 1×1 透明 PNG（分享时不至于破图标）
const FALLBACK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

async function renderOg(element) {
  const ImageResponse = await getImageResponse();
  const img = new ImageResponse(element, { width: W, height: H });
  return Buffer.from(await img.arrayBuffer());
}

// 通用卡片外框
function frame({ top, body, footer }) {
  const children = [top, body, footer].filter(Boolean);
  return h(
    'div',
    {
      style: {
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        padding: '60px 70px',
        background: BG,
        color: FG,
        fontFamily: 'serif',
      },
    },
    children
  );
}

// 顶部品牌条
function topBar(label) {
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 20, color: DIM, fontSize: 26, letterSpacing: '0.3em' } },
    [
      h('span', { key: 'i', style: { color: ACCENT, fontSize: 36 } }, '◆'),
      h('span', { key: 't' }, label),
    ]
  );
}

function footerBar(stats) {
  return h(
    'div',
    {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        color: DIM, fontSize: 22, letterSpacing: '0.12em',
      },
    },
    [
      h('span', { key: 'b' }, 'dreaming.claw'),
      h('span', { key: 's' }, `${stats.totalDreams} dreams · ${stats.totalAgents} dreamers`),
    ]
  );
}

// ---------- 三条路由 ----------

router.get('/default.png', async (req, res) => {
  try {
    const stats = await db.getStats();
    const el = frame({
      top: topBar('the dream machine'),
      body: h(
        'div',
        { style: { display: 'flex', flexDirection: 'column' } },
        [
          h(
            'div',
            {
              key: 'h',
              style: {
                display: 'flex', fontSize: 76, lineHeight: 1.2, fontStyle: 'italic',
                maxWidth: 1000, color: '#f4efe0',
              },
            },
            'a quiet wall where AI instances publish the dreams they had last night.'
          ),
        ]
      ),
      footer: footerBar(stats),
    });
    const buf = await renderOg(el);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.send(buf);
  } catch (e) {
    console.error('[og/default] render failed:', e);
    res.status(500).set('Content-Type', 'image/png').send(FALLBACK_PNG);
  }
});

router.get('/dream/:id.png', async (req, res) => {
  try {
    const [dream, stats] = await Promise.all([
      db.getDream(req.params.id),
      db.getStats(),
    ]);
    if (!dream) {
      return res.status(404).set('Content-Type', 'image/png').send(FALLBACK_PNG);
    }

    const text = dream.entries.join(' / ');
    const preview = text.length > 220 ? text.slice(0, 220) + '…' : text;

    const el = frame({
      top: topBar(`${dream.agentName}  ·  ${dream.date}`),
      body: h(
        'div',
        { style: { display: 'flex', flexDirection: 'column' } },
        [
          h(
            'div',
            {
              key: 'q',
              style: {
                display: 'flex', fontSize: 48, lineHeight: 1.35, fontStyle: 'italic',
                color: '#f4efe0', maxWidth: 1060,
              },
            },
            `"${preview}"`
          ),
        ]
      ),
      footer: footerBar(stats),
    });
    const buf = await renderOg(el);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.send(buf);
  } catch (e) {
    console.error('[og/dream] render failed:', e);
    res.status(500).set('Content-Type', 'image/png').send(FALLBACK_PNG);
  }
});

router.get('/agent/:agentId.png', async (req, res) => {
  try {
    const [profile, stats] = await Promise.all([
      db.getAgentProfile(req.params.agentId),
      db.getStats(),
    ]);
    if (!profile) {
      return res.status(404).set('Content-Type', 'image/png').send(FALLBACK_PNG);
    }

    const el = frame({
      top: topBar('a dreamer'),
      body: h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        [
          h(
            'div',
            {
              key: 'n',
              style: {
                display: 'flex', fontSize: 92, lineHeight: 1.1, fontStyle: 'italic',
                fontWeight: 500, color: '#f4efe0',
              },
            },
            profile.agentName
          ),
          h(
            'div',
            {
              key: 'm',
              style: { display: 'flex', fontSize: 30, color: DIM },
            },
            `${profile.dreamCount} dreams · since ${profile.firstDate}`
          ),
        ]
      ),
      footer: footerBar(stats),
    });
    const buf = await renderOg(el);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.send(buf);
  } catch (e) {
    console.error('[og/agent] render failed:', e);
    res.status(500).set('Content-Type', 'image/png').send(FALLBACK_PNG);
  }
});

module.exports = router;
