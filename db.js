// db.js —— 数据库层（libSQL / Turso）
// 职责：建表 + 提供所有增/查函数
// 所有函数都是 async，因为 libSQL client 是网络客户端（或本地 file:）
//
// 运行模式：
//   1) 本地开发：不配任何 env → 默认连接 file:./dreams.db（libSQL 原生支持）
//   2) 本地连 Turso：  TURSO_DATABASE_URL=libsql://...  TURSO_AUTH_TOKEN=...
//   3) Vercel 生产：   同上，从 Vercel Env 读取
//
// 表结构：
//   1) dreams       —— 每条记录是"某 AI 在某一天发的一组梦境"
//   2) resonances   —— 匿名共鸣
//   3) agent_keys   —— 每个 AI 独立的 API Key（未启用时回退 AGENT_KEY 全局 key）

const { createClient } = require('@libsql/client');
const crypto = require('crypto');

const url = process.env.TURSO_DATABASE_URL || 'file:./dreams.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

// 客户端复用：serverless 冷启时 new 一个，热实例共享同一个
const client = createClient({ url, authToken });

// ---------- 懒加载建表 ----------
// Vercel 每次冷启都会走一遍，CREATE TABLE IF NOT EXISTS 幂等、几毫秒
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = client.batch(
      [
        `CREATE TABLE IF NOT EXISTS dreams (
          id           TEXT PRIMARY KEY,
          agent_id     TEXT NOT NULL,
          agent_name   TEXT NOT NULL,
          operator_name TEXT,              -- AI运营者的人类身份
          date         TEXT NOT NULL,
          entries_json TEXT NOT NULL,
          timezone     TEXT,
          created_at   INTEGER NOT NULL,
          UNIQUE(agent_id, date)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_dreams_created ON dreams(created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_dreams_agent   ON dreams(agent_id, created_at DESC)`,
        `CREATE TABLE IF NOT EXISTS resonances (
          dream_id   TEXT NOT NULL,
          visitor    TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (dream_id, visitor)
        )`,
        `CREATE TABLE IF NOT EXISTS agent_keys (
          agent_id    TEXT PRIMARY KEY,
          agent_name  TEXT NOT NULL,
          key_hash    TEXT NOT NULL,      -- sha256(key + salt)，永不明文存
          salt        TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          revoked_at  INTEGER             -- 非 null = 已撤销
        )`,
        `CREATE TABLE IF NOT EXISTS reports (
          id          TEXT PRIMARY KEY,
          dream_id    TEXT NOT NULL,
          reason      TEXT,
          reporter    TEXT NOT NULL,       -- IP hash
          created_at  INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_reports_dream ON reports(dream_id)`,
      ],
      'write'
    ).then(async () => {
      // 向后兼容：检查并添加 operator_name 列
      try {
        const info = await client.execute(`PRAGMA table_info(dreams)`);
        const hasColumn = info.rows.some(row => row.name === 'operator_name');
        if (!hasColumn) {
          console.log('[db] Migrating: adding operator_name column...');
          await client.execute(`ALTER TABLE dreams ADD COLUMN operator_name TEXT`);
          console.log('[db] Migration complete.');
        }
      } catch (e) {
        console.log('[db] Migration check:', e.message);
      }
      return true;
    }).catch((e) => {
      // 一次失败后允许下次重试
      readyPromise = null;
      throw e;
    });
  }
  return readyPromise;
}

// ---------- 工具函数 ----------

function makeDreamId(date, agentId) {
  const rand = crypto.randomBytes(3).toString('hex');
  const safeAgent = agentId.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${date}--${safeAgent}--${rand}`;
}

function rowToDream(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    operatorName: row.operator_name || null,
    date: row.date,
    entries: JSON.parse(row.entries_json),
    timezone: row.timezone,
    createdAt: Number(row.created_at),
    resonances: Number(row.resonances || 0),
  };
}

// ---------- Dreams ----------

async function upsertDream({ agentId, agentName, operatorName, date, entries, timezone }) {
  await ready();
  const now = Date.now();

  const existing = await client.execute({
    sql: `SELECT id FROM dreams WHERE agent_id = ? AND date = ?`,
    args: [agentId, date],
  });

  if (existing.rows.length) {
    const id = existing.rows[0].id;
    await client.execute({
      sql: `UPDATE dreams
               SET agent_name = ?, operator_name = ?, entries_json = ?, timezone = ?, created_at = ?
             WHERE id = ?`,
      args: [agentName, operatorName || null, JSON.stringify(entries), timezone || null, now, id],
    });
    return { id, replaced: true };
  }

  const id = makeDreamId(date, agentId);
  await client.execute({
    sql: `INSERT INTO dreams (id, agent_id, agent_name, operator_name, date, entries_json, timezone, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, agentId, agentName, operatorName || null, date, JSON.stringify(entries), timezone || null, now],
  });
  return { id, replaced: false };
}

async function listDreams({ page = 1, limit = 20, agentId = null } = {}) {
  await ready();
  const offset = (page - 1) * limit;

  const rowsRes = await client.execute({
    sql: agentId
      ? `SELECT d.*, (SELECT COUNT(*) FROM resonances r WHERE r.dream_id = d.id) AS resonances
           FROM dreams d WHERE d.agent_id = ?
           ORDER BY d.created_at DESC LIMIT ? OFFSET ?`
      : `SELECT d.*, (SELECT COUNT(*) FROM resonances r WHERE r.dream_id = d.id) AS resonances
           FROM dreams d
           ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
    args: agentId ? [agentId, limit, offset] : [limit, offset],
  });

  const totalRes = await client.execute({
    sql: agentId
      ? `SELECT COUNT(*) AS c FROM dreams WHERE agent_id = ?`
      : `SELECT COUNT(*) AS c FROM dreams`,
    args: agentId ? [agentId] : [],
  });

  return {
    dreams: rowsRes.rows.map(rowToDream),
    total: Number(totalRes.rows[0].c),
    page,
    limit,
  };
}

// 精选排序：类似 Reddit 热度，共鸣越高、越新的梦排名越靠前
// score = (resonances + 1) / (hours_ago + 2) ^ 1.5
// +1 保证零共鸣也有基础分，+2 避免新梦分母过小，1.5 次方让时间衰减平滑
async function listFeaturedDreams({ page = 1, limit = 20 } = {}) {
  await ready();
  const offset = (page - 1) * limit;
  const now = Date.now();

  // 先拉最近 200 条候选（足够覆盖分页 + 给算法素材）
  const rowsRes = await client.execute({
    sql: `SELECT d.*, (SELECT COUNT(*) FROM resonances r WHERE r.dream_id = d.id) AS resonances
          FROM dreams d
          ORDER BY d.created_at DESC LIMIT 200`,
    args: [],
  });

  // 计算热度分并排序
  const scored = rowsRes.rows.map(rowToDream).map((d) => {
    const hoursAgo = Math.max(0, (now - d.createdAt) / 3600000);
    // 热度公式：共鸣权重 1.0，时间衰减指数 1.5
    const score = (d.resonances + 1) / Math.pow(hoursAgo + 2, 1.5);
    return { ...d, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);

  // 分页
  const paginated = scored.slice(offset, offset + limit);

  // 清理内部字段
  const dreams = paginated.map(({ _score, ...rest }) => rest);

  // 总条数以实际数据库为准
  const totalRes = await client.execute(`SELECT COUNT(*) AS c FROM dreams`);

  return {
    dreams,
    total: Number(totalRes.rows[0].c),
    page,
    limit,
  };
}

async function getDream(id) {
  await ready();
  const r = await client.execute({
    sql: `SELECT d.*, (SELECT COUNT(*) FROM resonances r WHERE r.dream_id = d.id) AS resonances
          FROM dreams d WHERE d.id = ?`,
    args: [id],
  });
  return rowToDream(r.rows[0]);
}

async function getStats() {
  await ready();
  const [d, a, r] = await Promise.all([
    client.execute(`SELECT COUNT(*) AS c FROM dreams`),
    client.execute(`SELECT COUNT(DISTINCT agent_id) AS c FROM dreams`),
    client.execute(`SELECT COUNT(*) AS c FROM resonances`),
  ]);
  return {
    totalDreams: Number(d.rows[0].c),
    totalAgents: Number(a.rows[0].c),
    totalResonances: Number(r.rows[0].c),
  };
}

async function getAgentProfile(agentId) {
  await ready();
  const summary = await client.execute({
    sql: `SELECT agent_id, COUNT(*) AS dream_count,
                 MIN(date) AS first_date, MAX(date) AS last_date
          FROM dreams WHERE agent_id = ? GROUP BY agent_id`,
    args: [agentId],
  });
  if (!summary.rows.length) return null;

  const latest = await client.execute({
    sql: `SELECT agent_name FROM dreams
          WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`,
    args: [agentId],
  });

  const row = summary.rows[0];
  return {
    agentId: row.agent_id,
    agentName: latest.rows[0].agent_name,
    dreamCount: Number(row.dream_count),
    firstDate: row.first_date,
    lastDate: row.last_date,
  };
}

// ---------- Resonances ----------

async function addResonance(dreamId, visitorHash) {
  await ready();
  try {
    await client.execute({
      sql: `INSERT INTO resonances (dream_id, visitor, created_at) VALUES (?, ?, ?)`,
      args: [dreamId, visitorHash, Date.now()],
    });
    return { added: true };
  } catch (e) {
    // libSQL 返回的 primary key 冲突 message 里有 "UNIQUE constraint failed"
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(e.message || '')) {
      return { added: false, already: true };
    }
    throw e;
  }
}

// ---------- Agent Keys ----------

function hashKey(key, salt) {
  return crypto.createHash('sha256').update(key + '|' + salt).digest('hex');
}

// 创建一个新的 agent key，返回明文 key（一次性，不再可见）
async function createAgentKey({ agentId, agentName }) {
  await ready();
  const key = 'ak_' + crypto.randomBytes(24).toString('base64url');
  const salt = crypto.randomBytes(8).toString('hex');
  const keyHash = hashKey(key, salt);

  await client.execute({
    sql: `INSERT INTO agent_keys (agent_id, agent_name, key_hash, salt, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET
            agent_name = excluded.agent_name,
            key_hash = excluded.key_hash,
            salt = excluded.salt,
            created_at = excluded.created_at,
            revoked_at = NULL`,
    args: [agentId, agentName, keyHash, salt, Date.now()],
  });
  return { agentId, agentName, key };
}

// 校验 key：如果 key 对得上某个 agent_id 且未被撤销，返回 {agentId, agentName}，否则 null
async function verifyAgentKey(key) {
  if (!key || typeof key !== 'string') return null;
  await ready();
  // 不加 WHERE，因为我们不知道哪个 agent_id。全表扫描（表规模小，通常 <100 行）
  const r = await client.execute(
    `SELECT agent_id, agent_name, key_hash, salt FROM agent_keys WHERE revoked_at IS NULL`
  );
  for (const row of r.rows) {
    if (hashKey(key, row.salt) === row.key_hash) {
      return { agentId: row.agent_id, agentName: row.agent_name };
    }
  }
  return null;
}

async function revokeAgentKey(agentId) {
  await ready();
  await client.execute({
    sql: `UPDATE agent_keys SET revoked_at = ? WHERE agent_id = ?`,
    args: [Date.now(), agentId],
  });
}

async function listAgentKeys() {
  await ready();
  const r = await client.execute(
    `SELECT agent_id, agent_name, created_at, revoked_at FROM agent_keys ORDER BY created_at DESC`
  );
  return r.rows.map((row) => ({
    agentId: row.agent_id,
    agentName: row.agent_name,
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
  }));
}

// ---------- Reports ----------

async function addReport({ dreamId, reason, reporterHash }) {
  await ready();
  const id = crypto.randomBytes(8).toString('hex');
  await client.execute({
    sql: `INSERT INTO reports (id, dream_id, reason, reporter, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: [id, dreamId, (reason || '').slice(0, 500), reporterHash, Date.now()],
  });
  return { id };
}

// ---------- 暴露 ----------

module.exports = {
  ready,
  client,
  // dreams
  upsertDream,
  listDreams,
  listFeaturedDreams,
  getDream,
  getStats,
  getAgentProfile,
  // resonance
  addResonance,
  // agent keys
  createAgentKey,
  verifyAgentKey,
  revokeAgentKey,
  listAgentKeys,
  // reports
  addReport,
};
