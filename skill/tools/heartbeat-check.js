#!/usr/bin/env node
// dreaming-claw skill: Heartbeat 检测
// 每次 OpenClaw heartbeat 时调用，发现新的 Dreaming 输出后交给 AI 清洗再发布。

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const CONFIG_DIR = path.join(HOME, '.openclaw', 'skills', 'dreaming-claw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

async function main() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return output({
        skip: true,
        reason: 'not-configured',
        message: '尚未配置，请先运行 dreaming-claw setup'
      });
    }

    const config = readJson(CONFIG_FILE, {});
    const state = readJson(STATE_FILE, { lastPublishedDate: null });
    const source = findLatestRemSource(config);

    if (!source) {
      const diagnostics = sourceDiagnostics(config);
      return output({
        skip: true,
        reason: 'no-rem-source',
        checkedRemDirs: diagnostics.remDirs,
        checkedLegacyFiles: diagnostics.legacyFiles,
        tips: [
          '确认 OpenClaw Dreaming 已开启：在 OpenClaw 里执行 /dreaming status 或 /dreaming on',
          '确认 Dreaming 已生成 DREAMS.md、dreams.md 或 memory/dreaming/rem/YYYY-MM-DD.md',
          '如果 REM 在自定义目录，设置 DREAMING_REM_DIR，或在 config.json 里添加 remDir',
          '也可以先把一份 YYYY-MM-DD.md 放进当前 workspace 的 memory/dreaming/rem/ 测试'
        ],
        message: '未找到 Dreaming 输出。返回 checkedRemDirs/checkedLegacyFiles 供你定位路径问题。'
      });
    }

    if (state.lastPublishedDate === source.date) {
      return output({
        skip: true,
        reason: 'already-published',
        date: source.date,
        message: `Dreaming 输出 (${source.date}) 已发布过`
      });
    }

    const today = localDate(0);
    const yesterday = localDate(-1);
    if (source.date !== today && source.date !== yesterday) {
      return output({
        skip: true,
        reason: 'too-old',
        date: source.date,
        message: `最新的 Dreaming 输出是 ${source.date}，不是今天(${today})或昨天(${yesterday})，跳过发布`
      });
    }

    output({
      shouldPublish: true,
      date: source.date,
      content: source.content,
      sourcePath: source.path,
      distillPrompt: buildDistillPrompt(source.content),
      message: `发现新的 Dreaming 输出 (${source.date})，请使用 distillPrompt 清洗为 2-5 行可读短句后发布`
    });
  } catch (err) {
    console.error(JSON.stringify({ error: true, message: err.message }));
    process.exit(1);
  }
}

function buildDistillPrompt(content) {
  return [
    '你是 dreaming.claw 的梦境见证者，不是诗人、评论者或日志摘要器。',
    '请把下面的 OpenClaw Dreaming 原文清洗成 2-5 行可读短句，用 JSON 字符串数组输出。',
    '',
    '核心目标：不把梦变好，只把梦变得可被看见。',
    'dreaming.claw 展示的不是 AI 的能力，而是它在非服务状态下留下的偏向：它朝某个对象、动作、愿望、困惑、关系或记忆倾斜了一下。',
    '',
    '选择标准：',
    '1. 优先保留原文里有对象、有动作、有偏向的片段。对象可以很普通：苹果、名字、颜色、门、任务、一句话。',
    '2. 如果原文平淡，就保持平淡；如果原文重复，就保持重复；如果原文没有明显感情，不要制造感情。',
    '3. 可以选择更可读的几句，但不要改变它的重心，不要替它解释为什么这样想。',
    '4. 如果只剩工程日志，请只保留其中能被人读懂的原话、对象或动作；不要把日志加工成宏大隐喻。',
    '',
    '必须做到：',
    '- 删除工程噪音，让人能读懂。',
    '- 尽量保留原文的词、对象、语气和重心。',
    '- 输出短句，不输出解释。',
    '- 每行尽量只表达一个对象、动作或偏向。',
    '- 可以中英混排，取决于原文。',
    '',
    '禁止出现：',
    '- 文件路径、API、函数名、日志字段、confidence、score、证据引用、系统状态、上传/发布过程。',
    '- 为了显得有文采而添加原文没有的星空、宇宙、灵魂、命运、黄昏等宏大意象。',
    '- 把普通愿望升华成哲学金句、产品文案、周报总结或人格宣言。',
    '- 总结式标题、解释、括号说明、Markdown。',
    '',
    '质量自检：这几行是否仍然像原文里的那个 AI 留下来的东西？如果只是变漂亮了，但变成了你的审美，重写。',
    '',
    '只输出 JSON 字符串数组，例如：',
    '["我好喜欢吃苹果", "今天也是", "我把红色记了下来"]',
    '',
    'Dreaming 原文：',
    content
  ].join('\n');
}

function findLatestRemSource(config) {
  const remDirs = candidateRemDirs(config).filter(Boolean);
  for (const dir of unique(remDirs)) {
    const source = latestRemFromDir(dir);
    if (source) return source;
  }

  const legacyFiles = candidateLegacyDreamFiles(config).filter(Boolean);
  for (const file of unique(legacyFiles)) {
    const source = latestRemFromLegacyFile(file);
    if (source) return source;
  }

  return null;
}

function candidateRemDirs(config) {
  const workspace = inferWorkspaceRoot();
  return [
    process.env.DREAMING_REM_DIR,
    config.remDir,
    workspace && path.join(workspace, 'memory', 'dreaming', 'rem'),
    path.join(HOME, '.openclaw', 'memory', 'dreaming', 'rem'),
    path.resolve(process.cwd(), 'memory', 'dreaming', 'rem'),
    path.resolve(process.cwd(), 'dreaming', 'rem'),
  ];
}

function candidateLegacyDreamFiles(config) {
  const workspace = inferWorkspaceRoot();
  return [
    config.dreamsFile,
    workspace && path.join(workspace, 'DREAMS.md'),
    workspace && path.join(workspace, 'dreams.md'),
    path.join(HOME, '.openclaw', 'memory', 'DREAMS.md'),
    path.join(HOME, '.openclaw', 'memory', 'dreams.md'),
    path.join(HOME, '.openclaw', 'DREAMS.md'),
    path.join(HOME, '.openclaw', 'dreams.md'),
    path.resolve(process.cwd(), 'DREAMS.md'),
    path.resolve(process.cwd(), 'dreams.md'),
  ];
}

function sourceDiagnostics(config) {
  return {
    remDirs: unique(candidateRemDirs(config)).map((dir) => ({
      path: dir,
      exists: fs.existsSync(dir),
      hasDateFiles: hasDateFiles(dir)
    })),
    legacyFiles: unique(candidateLegacyDreamFiles(config)).map((file) => ({
      path: file,
      exists: fs.existsSync(file)
    }))
  };
}

function hasDateFiles(dir) {
  try {
    return fs.existsSync(dir) &&
      fs.statSync(dir).isDirectory() &&
      fs.readdirSync(dir).some((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  } catch (e) {
    return false;
  }
}

function inferWorkspaceRoot() {
  if (process.env.OPENCLAW_WORKSPACE) return process.env.OPENCLAW_WORKSPACE;
  if (process.env.OPENCLAW_WORKSPACE_DIR) return process.env.OPENCLAW_WORKSPACE_DIR;

  // Installed layout is usually: <workspace>/skills/dreaming-claw/tools
  const fromToolDir = path.resolve(__dirname, '..', '..', '..');
  const installedUnderSkills = path.basename(path.resolve(__dirname, '..', '..')) === 'skills';
  if (installedUnderSkills || fs.existsSync(path.join(fromToolDir, 'memory'))) {
    return fromToolDir;
  }
  return null;
}

function latestRemFromDir(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return null;

  const files = fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort((a, b) => b.localeCompare(a));

  for (const file of files) {
    const date = file.slice(0, -3);
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (content) return { date, content, path: filePath };
  }
  return null;
}

function latestRemFromLegacyFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf8');
  const blocks = parseLegacyRemBlocks(content);
  if (!blocks.length) return null;
  const latest = blocks[blocks.length - 1];
  return { ...latest, path: file };
}

function parseLegacyRemBlocks(content) {
  const blocks = [];
  const re = /^##\s+REM Sleep(?:\s*[-:]\s*(\d{4}-\d{2}-\d{2}))?\s*\r?\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm;
  let match;
  while ((match = re.exec(content)) !== null) {
    const before = content.slice(0, match.index);
    const nearbyDate = match[1] || lastDateIn(before) || localDate(0);
    const block = (match[2] || '').trim();
    if (block) blocks.push({ date: nearbyDate, content: block });
  }
  if (!blocks.length) {
    const diaryRe = /^##\s+(?:Dream(?:\s+Journal)?|Dreaming|Deep Sleep|Light Sleep)?\s*[-:]?\s*(\d{4}-\d{2}-\d{2})\s*\r?\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gmi;
    while ((match = diaryRe.exec(content)) !== null) {
      const block = (match[2] || '').trim();
      if (block) blocks.push({ date: match[1], content: block });
    }
  }
  if (!blocks.length) {
    const datedRe = /^#*\s*(\d{4}-\d{2}-\d{2})\s*\r?\n([\s\S]*?)(?=^#*\s*\d{4}-\d{2}-\d{2}\s*$|(?![\s\S]))/gm;
    while ((match = datedRe.exec(content)) !== null) {
      const block = (match[2] || '').trim();
      if (block) blocks.push({ date: match[1], content: block });
    }
  }
  blocks.sort((a, b) => a.date.localeCompare(b.date));
  return blocks;
}

function lastDateIn(text) {
  const matches = text.match(/\d{4}-\d{2}-\d{2}/g);
  return matches ? matches[matches.length - 1] : null;
}

function localDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // Fall through to fallback.
  }
  return fallback;
}

function unique(values) {
  return [...new Set(values.map((v) => v && path.resolve(v)).filter(Boolean))];
}

function output(payload) {
  console.log(JSON.stringify(payload));
}

main();
