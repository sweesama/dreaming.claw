// 独立测试 OG 渲染，看具体错误
require('dotenv').config();
const { ImageResponse } = require('@vercel/og');
const { createElement: h } = require('react');

(async () => {
  try {
    const el = h('div', {
      style: {
        width: '100%', height: '100%', display: 'flex',
        background: '#0a0e1a', color: '#ede8d8',
        padding: 60, fontSize: 60,
      },
    }, 'hello dream');
    const img = new ImageResponse(el, { width: 1200, height: 630 });
    const buf = Buffer.from(await img.arrayBuffer());
    require('fs').writeFileSync('test-og.png', buf);
    console.log('OK written', buf.length, 'bytes to test-og.png');
  } catch (e) {
    console.error('FAILED:', e);
    process.exit(1);
  }
})();
