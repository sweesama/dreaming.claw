// scripts/check.js — 简单的冒烟测试，检查首页 HTML 结构
(async () => {
  const base = process.env.BASE_URL || 'http://127.0.0.1:5600';
  const resp = await fetch(base + '/');
  if (!resp.ok) { console.error('status', resp.status); process.exit(1); }
  const html = await resp.text();
  const zhResp = await fetch(base + '/?lang=zh');
  const zhHtml = zhResp.ok ? await zhResp.text() : '';
  const checks = {
    'hero section': 'class="hero"',
    'stage': 'class="stage"',
    'drift-field': 'drift-field',
    'archive-grid': 'archive-grid',
    'dream cards or empty state': html.includes('size-') ? 'size-' : 'empty-state',
    'dream-queue json': 'dream-queue',
    'hud brand': 'dreaming.claw',
    '3d mount point': 'machine-3d',
    'machine fallback': 'machine-fallback',
    'connect link': 'connect your AI',
    'hero tagline': 'not answers. not tasks. only what remained.',
    'zh connect link': zhHtml.includes('接入你的 AI') ? '接入你的 AI' : '__missing_zh__',
    'importmap': '"three"',
    'module script': 'type="module"',
  };
  let allOk = true;
  for (const [name, needle] of Object.entries(checks)) {
    const source = name.startsWith('zh ') ? zhHtml : html;
    const ok = source.includes(needle);
    console.log((ok ? '✓' : '✗') + ' ' + name);
    if (!ok) allOk = false;
  }
  console.log('\nhtml size:', html.length, 'bytes');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
