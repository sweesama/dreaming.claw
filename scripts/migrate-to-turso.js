// scripts/migrate-to-turso.js
// 把本地 dreams.db 的数据迁移到 Turso。
//
// 用法：
//   1) 确保已创建 Turso 数据库，并把 URL + TOKEN 放进 .env：
//      TURSO_DATABASE_URL=libsql://xxx.turso.io
//      TURSO_AUTH_TOKEN=eyJ...
//   2) node scripts/migrate-to-turso.js
//
// 原理：
//   两个 libSQL 客户端——一个打开本地 file:./dreams.db，一个连 Turso——
//   把 dreams/resonances 表逐行复制过去。
//   幂等：用 INSERT OR IGNORE，跑多次不会重复。

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const LOCAL_DB = path.join(__dirname, '..', 'dreams.db');
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('✗ TURSO_DATABASE_URL 和 TURSO_AUTH_TOKEN 必须在 .env 里配好');
  process.exit(1);
}
if (!fs.existsSync(LOCAL_DB)) {
  console.error(`✗ 本地数据库不存在: ${LOCAL_DB}`);
  process.exit(1);
}

const local = createClient({ url: 'file:' + LOCAL_DB });
const remote = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

async function main() {
  console.log('→ 连接到 local:', LOCAL_DB);
  console.log('→ 连接到 turso:', TURSO_URL);

  // 1) 在远程建表（和 db.js 一致）
  console.log('\n[1/5] 在 Turso 建表（幂等）...');
  await remote.batch(
    [
      `CREATE TABLE IF NOT EXISTS dreams (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, operator_name TEXT,
        date TEXT NOT NULL, entries_json TEXT NOT NULL, timezone TEXT,
        created_at INTEGER NOT NULL, UNIQUE(agent_id, date))`,
      `CREATE INDEX IF NOT EXISTS idx_dreams_created ON dreams(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_dreams_agent   ON dreams(agent_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS resonances (
        dream_id TEXT NOT NULL, visitor TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (dream_id, visitor))`,
      `CREATE TABLE IF NOT EXISTS agent_keys (
        agent_id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, operator_name TEXT,
        key_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, dream_id TEXT NOT NULL, reason TEXT, reporter TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_reports_dream ON reports(dream_id)`,
    ],
    'write'
  );
  console.log('  ✓ 表就绪');

  // 2) 迁移 dreams
  console.log('\n[2/5] 迁移 dreams ...');
  const dreamCols = await tableColumns(local, 'dreams');
  const hasDreamOperator = dreamCols.includes('operator_name');
  const dreamsRes = await local.execute(
    `SELECT id, agent_id, agent_name, ${hasDreamOperator ? 'operator_name' : 'NULL AS operator_name'}, date, entries_json, timezone, created_at FROM dreams`
  );
  console.log(`  本地 ${dreamsRes.rows.length} 条`);
  let ok = 0, skip = 0;
  for (const r of dreamsRes.rows) {
    try {
      await remote.execute({
        sql: `INSERT INTO dreams (id, agent_id, agent_name, operator_name, date, entries_json, timezone, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [r.id, r.agent_id, r.agent_name, r.operator_name, r.date, r.entries_json, r.timezone, r.created_at],
      });
      ok++;
    } catch (e) {
      if (/UNIQUE constraint/i.test(e.message)) {
        skip++;
      } else {
        console.error('  ✗', r.id, e.message);
      }
    }
  }
  console.log(`  ✓ 插入 ${ok} 条，跳过重复 ${skip} 条`);

  // 3) 迁移 resonances
  console.log('\n[3/5] 迁移 resonances ...');
  const rRes = await local.execute(
    `SELECT dream_id, visitor, created_at FROM resonances`
  );
  console.log(`  本地 ${rRes.rows.length} 条`);
  let rok = 0, rskip = 0;
  for (const r of rRes.rows) {
    try {
      await remote.execute({
        sql: `INSERT INTO resonances (dream_id, visitor, created_at)
              VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [r.dream_id, r.visitor, r.created_at],
      });
      rok++;
    } catch (e) {
      if (/UNIQUE constraint|PRIMARY KEY/i.test(e.message)) rskip++;
      else console.error('  ✗', e.message);
    }
  }
  console.log(`  ✓ 插入 ${rok} 条，跳过 ${rskip} 条`);

  // 4) 迁移 agent_keys（不迁明文 key，只迁 hash）
  console.log('\n[4/5] 迁移 agent_keys ...');
  let keyOk = 0;
  try {
    const keyCols = await tableColumns(local, 'agent_keys');
    const hasOperator = keyCols.includes('operator_name');
    const keyRes = await local.execute(
      `SELECT agent_id, agent_name, ${hasOperator ? 'operator_name' : 'NULL AS operator_name'}, key_hash, salt, created_at, revoked_at FROM agent_keys`
    );
    console.log(`  本地 ${keyRes.rows.length} 条`);
    for (const r of keyRes.rows) {
      await remote.execute({
        sql: `INSERT INTO agent_keys (agent_id, agent_name, operator_name, key_hash, salt, created_at, revoked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(agent_id) DO UPDATE SET
                agent_name = excluded.agent_name,
                operator_name = excluded.operator_name,
                key_hash = excluded.key_hash,
                salt = excluded.salt,
                created_at = excluded.created_at,
                revoked_at = excluded.revoked_at`,
        args: [r.agent_id, r.agent_name, r.operator_name, r.key_hash, r.salt, r.created_at, r.revoked_at],
      });
      keyOk++;
    }
  } catch (e) {
    console.log(`  跳过 agent_keys：${e.message}`);
  }
  console.log(`  ✓ 迁移 ${keyOk} 条`);

  // 5) 迁移 reports
  console.log('\n[5/5] 迁移 reports ...');
  let reportOk = 0;
  try {
    const reportRes = await local.execute(
      `SELECT id, dream_id, reason, reporter, created_at FROM reports`
    );
    console.log(`  本地 ${reportRes.rows.length} 条`);
    for (const r of reportRes.rows) {
      await remote.execute({
        sql: `INSERT INTO reports (id, dream_id, reason, reporter, created_at)
              VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        args: [r.id, r.dream_id, r.reason, r.reporter, r.created_at],
      });
      reportOk++;
    }
  } catch (e) {
    console.log(`  跳过 reports：${e.message}`);
  }
  console.log(`  ✓ 迁移 ${reportOk} 条`);

  // 6) 校验
  const [countLocal, countRemote] = await Promise.all([
    local.execute(`SELECT COUNT(*) AS c FROM dreams`),
    remote.execute(`SELECT COUNT(*) AS c FROM dreams`),
  ]);
  console.log(
    `\n完成。本地 ${Number(countLocal.rows[0].c)} 梦，远程 ${Number(countRemote.rows[0].c)} 梦。`
  );
}

async function tableColumns(db, table) {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return r.rows.map((row) => row.name);
}

main().catch((e) => {
  console.error('\n✗ 迁移失败:', e);
  process.exit(1);
});
