// scripts/smoke.js —— 简单的端到端冒烟测试
// 用法：先启动 server，然后 node scripts/smoke.js

const BASE = 'http://127.0.0.1:3000';

const paths = [
  ['/', 'text/html'],
  ['/about', 'text/html'],
  ['/robots.txt', 'text/plain'],
  ['/sitemap.xml', 'application/xml'],
  ['/feed.xml', 'application/rss'],
  ['/healthz', 'application/json'],
  ['/api/stats', 'application/json'],
  ['/api/dreams', 'application/json'],
  ['/og/default.png', 'image/png'],
  ['/d/unknown', 'text/html', 404],
  ['/ai/ghost', 'text/html', 404],
];

(async () => {
  let fail = 0;
  for (const [path, mustInclude, expectStatus] of paths) {
    try {
      const r = await fetch(BASE + path);
      const expectedStatus = expectStatus || 200;
      const ct = r.headers.get('content-type') || '';
      const ok = r.status === expectedStatus && ct.includes(mustInclude);
      const buf = await r.arrayBuffer();
      console.log(
        (ok ? '✓' : '✗') +
          ' ' + path.padEnd(22) +
          ` [${r.status}] ` + ct.padEnd(32) + ` ${buf.byteLength}B`
      );
      if (!ok) fail++;
    } catch (e) {
      console.log('✗ ' + path + ' ERROR: ' + e.message);
      fail++;
    }
  }
  console.log(fail === 0 ? '\n✅ ALL OK' : `\n❌ ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
