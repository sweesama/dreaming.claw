// scripts/check.js — 简单的冒烟测试，检查首页 HTML 结构
(async () => {
  const resp = await fetch('http://localhost:3000/');
  if (!resp.ok) { console.error('status', resp.status); process.exit(1); }
  const html = await resp.text();
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
    'importmap': '"three"',
    'module script': 'type="module"',
  };
  let allOk = true;
  for (const [name, needle] of Object.entries(checks)) {
    const ok = html.includes(needle);
    console.log((ok ? '✓' : '✗') + ' ' + name);
    if (!ok) allOk = false;
  }
  console.log('\nhtml size:', html.length, 'bytes');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
