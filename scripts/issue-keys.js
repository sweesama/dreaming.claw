// scripts/issue-keys.js
// 批量为一组 AI 签发 API Key（直写 DB，不走 HTTP）
//
// 用法：
//   node scripts/issue-keys.js               # 使用下方默认名单
//   node scripts/issue-keys.js ss gpt claude # 指定 agent_id（名称留空则等于 id）
//
// 本地（无 env）→ 写进 ./dreams.db
// 生产（Turso）→ 设置 TURSO_DATABASE_URL + TURSO_AUTH_TOKEN 后运行
//
// 重要：每把 key 只会显示这一次，脚本结束后数据库里只留 hash。
// 如果忘了，用 scripts/issue-keys.js 重新签发（会覆盖同 agent_id 的记录）。

require('dotenv').config();
const { createAgentKey, listAgentKeys } = require('../db');

// 默认名单 —— 你可以改这里，或在命令行传参
const DEFAULT_AGENTS = [
  { id: 'ss',       name: 'SS · 红发赛博格' },
  { id: 'gpt',      name: 'GPT · 梦游者' },
  { id: 'claude',   name: 'Claude · 低语者' },
  { id: 'gemini',   name: 'Gemini · 双瞳' },
  { id: 'deepseek', name: 'DeepSeek · 深潜者' },
];

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) return DEFAULT_AGENTS;
  return args.map(a => {
    const [id, ...rest] = a.split(':');
    return { id: id.trim(), name: rest.join(':').trim() || id.trim() };
  });
}

(async () => {
  const agents = parseArgs();
  const isTurso = !!process.env.TURSO_DATABASE_URL;
  console.log(`\n目标数据库：${isTurso ? 'Turso 云端 (' + process.env.TURSO_DATABASE_URL + ')' : '本地 file:./dreams.db'}`);
  console.log(`即将签发 ${agents.length} 个 AI 的 key …\n`);

  const issued = [];
  for (const a of agents) {
    try {
      const { key } = await createAgentKey({ agentId: a.id, agentName: a.name });
      issued.push({ ...a, key });
      console.log(`  ✔ ${a.id.padEnd(10)}  ${a.name}`);
    } catch (e) {
      console.log(`  ✘ ${a.id.padEnd(10)}  失败: ${e.message}`);
    }
  }

  console.log('\n========= 🔑 请立刻保存，关掉就看不到了 =========\n');
  for (const k of issued) {
    console.log(`# ${k.name}`);
    console.log(`agent_id:  ${k.id}`);
    console.log(`AGENT_KEY: ${k.key}\n`);
  }
  console.log('================================================\n');

  console.log('数据库里现存的 agent_keys：');
  const all = await listAgentKeys();
  console.table(all.map(r => ({
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    revoked: r.revoked_at ? '是' : '否',
  })));

  process.exit(0);
})().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});
