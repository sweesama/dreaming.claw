#!/usr/bin/env node
// dreaming-claw skill: Heartbeat 检测和发布
// 每次 OpenClaw heartbeat 时调用

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw', 'skills', 'dreaming-claw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

// 可能的 DREAMS.md 路径
const DREAMS_PATHS = [
  path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw', 'DREAMS.md'),
  path.join(process.env.HOME || process.env.USERPROFILE, 'DREAMS.md'),
  './DREAMS.md'
];

async function main() {
  try {
    // 1. 读取配置
    if (!fs.existsSync(CONFIG_FILE)) {
      console.log(JSON.stringify({
        skip: true,
        reason: 'not-configured',
        message: '尚未配置，请先运行 dreaming-claw setup'
      }));
      return;
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const state = fs.existsSync(STATE_FILE) 
      ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      : { lastPublishedDate: null };

    // 2. 找到 DREAMS.md
    const dreamsPath = DREAMS_PATHS.find(p => fs.existsSync(p));
    if (!dreamsPath) {
      console.log(JSON.stringify({
        skip: true,
        reason: 'no-dreams-file',
        message: '未找到 DREAMS.md，Dreaming 可能尚未运行'
      }));
      return;
    }

    // 3. 解析 REM Sleep 块
    const content = fs.readFileSync(dreamsPath, 'utf8');
    const remBlocks = parseRemBlocks(content);

    if (remBlocks.length === 0) {
      console.log(JSON.stringify({
        skip: true,
        reason: 'no-rem-blocks',
        message: 'DREAMS.md 中没有 ## REM Sleep 块'
      }));
      return;
    }

    // 4. 取最新的 REM 块
    const latestRem = remBlocks[remBlocks.length - 1];

    // 5. 检查是否已发布
    if (state.lastPublishedDate === latestRem.date) {
      console.log(JSON.stringify({
        skip: true,
        reason: 'already-published',
        date: latestRem.date,
        message: `REM Sleep (${latestRem.date}) 已发布过`
      }));
      return;
    }

    // 6. 检查日期是否是今天或昨天（防止发布太旧的梦）
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (latestRem.date !== today && latestRem.date !== yesterday) {
      console.log(JSON.stringify({
        skip: true,
        reason: 'too-old',
        date: latestRem.date,
        message: `最新的 REM Sleep 是 ${latestRem.date}，不是今天或昨天，跳过`
      }));
      return;
    }

    // 7. 提炼成短诗（这里需要 OpenClaw LLM 调用，实际由 AI 处理）
    // 输出待发布的内容，由 OpenClaw 调用 LLM 提炼后，再调用 publish
    console.log(JSON.stringify({
      shouldPublish: true,
      date: latestRem.date,
      content: latestRem.content,
      message: `发现新的 REM Sleep (${latestRem.date})，请提炼为 2-5 行短诗后发布`
    }));

  } catch (err) {
    console.error(JSON.stringify({
      error: true,
      message: err.message
    }));
    process.exit(1);
  }
}

// 解析 DREAMS.md 中的 ## REM Sleep 块
function parseRemBlocks(content) {
  const blocks = [];
  const remRegex = /## REM Sleep\s*\n(?:([^#]*)\n)?(?=## |$)/g;
  
  let match;
  while ((match = remRegex.exec(content)) !== null) {
    const blockContent = match[1] || match[0].replace(/## REM Sleep\s*\n/, '').trim();
    
    // 尝试从上下文找日期（前面的 ## Light Sleep 或文件修改时间）
    // 简单策略：从块前的内容找 YYYY-MM-DD 格式日期
    const beforeMatch = content.slice(0, match.index);
    const dateMatch = beforeMatch.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
    
    blocks.push({
      date,
      content: blockContent.trim(),
      index: match.index
    });
  }
  
  // 按日期排序
  blocks.sort((a, b) => a.date.localeCompare(b.date));
  
  return blocks;
}

main();
