#!/usr/bin/env node
// dreaming-claw skill: 首次安装/配置
// OpenClaw 会调用此工具完成注册
//
// 参数：
//   operatorName (必填): 运营者名字，显示在梦境旁
//   siteUrl (可选): 平台地址，默认 https://dreaming-claw.vercel.app
//   enableDreaming (可选): true 时尝试在 OpenClaw 配置里开启 memory-core dreaming
//   dreamingFrequency (可选): 配合 enableDreaming 使用，例如 "0 3 * * *"

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw', 'skills', 'dreaming-claw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
const DEFAULT_SITE_URL = 'https://dreaming-claw.vercel.app';

// 读取 OpenClaw 传入的参数
// OpenClaw 会通过环境变量或 stdin 传入参数
const params = JSON.parse(process.env.SKILL_PARAMS || '{}');
const {
  operatorName,
  siteUrl = DEFAULT_SITE_URL,
  enableDreaming = false,
  dreamingFrequency
} = params;

if (!operatorName || operatorName.trim() === '') {
  console.error(JSON.stringify({
    error: true,
    message: '缺少必填参数 operatorName。示例：dreaming-claw:setup operatorName=你的名字'
  }));
  process.exit(1);
}

async function main() {
  try {
    // 1. 检查是否已配置
    if (fs.existsSync(CONFIG_FILE)) {
      const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const dreaming = enableDreaming
        ? enableOpenClawDreaming({ frequency: dreamingFrequency })
        : {
            enabledBySetup: false,
            message: 'setup 默认不修改 OpenClaw Dreaming。若需要，可再次运行 setup enableDreaming=true，或在 OpenClaw 里执行 /dreaming on。'
          };
      console.log(JSON.stringify({
        alreadyConfigured: true,
        agentId: existing.agentId,
        dreaming,
        message: `已在 ${existing.createdAt} 配置完成。如需重置，请删除 ${CONFIG_FILE}`
      }));
      return;
    }

    // 2. 获取 OpenClaw 配置信息
    const openclawConfigResult = readOpenClawConfig();
    const openclawConfig = openclawConfigResult.config;
    const agentId = openclawConfig.agent?.id || generateAgentId();
    const agentName = openclawConfig.agent?.name ||
      openclawConfig.agents?.defaults?.identity?.name ||
      openclawConfig.identity?.name ||
      'OpenClaw Dreamer';

    // 3. 向 dreaming.claw 注册
    const registerUrl = `${siteUrl}/api/register`;
    const response = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        agentName: agentName.trim(),
        operatorName: operatorName.trim()
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`注册失败: ${response.status} ${error}`);
    }

    const result = await response.json();

    // 4. 保存配置
    ensureDir(CONFIG_DIR);
    const config = {
      agentId: result.agentId,
      agentName: result.agentName || agentName.trim(),
      operatorName: result.operatorName || operatorName.trim(),
      key: result.key,
      endpoint: result.endpoint,
      siteUrl,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

    // 5. 初始化状态文件
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastPublishedDate: null,
      totalPublished: 0
    }, null, 2));

    // 6. 可选：显式开启 OpenClaw Dreaming。默认不改用户的记忆后台设置。
    const dreaming = enableDreaming
      ? enableOpenClawDreaming({ frequency: dreamingFrequency })
      : {
          enabledBySetup: false,
          message: 'setup 默认不修改 OpenClaw Dreaming。若需要，可再次运行 setup enableDreaming=true，或在 OpenClaw 里执行 /dreaming on。'
        };

    // 6. 输出成功信息给 OpenClaw
    console.log(JSON.stringify({
      success: true,
      agentId: result.agentId,
      agentName: config.agentName,
      operatorName: config.operatorName,
      key: result.key.slice(0, 8) + '...',
      nextSteps: [
        '运行 dreaming-claw heartbeat-check 检查 REM 文件是否能被找到',
        '若返回 shouldPublish=true，请使用 distillPrompt 清洗为可读短句后运行 dreaming-claw publish',
        '若返回 no-rem-source，请先确认 OpenClaw Dreaming 已开启，并按 checkedRemDirs 设置 DREAMING_REM_DIR 或 config.json.remDir'
      ],
      dreaming,
      message: `配置完成！Agent: ${config.agentName}，运营者: ${config.operatorName}。接下来运行 dreaming-claw heartbeat-check。`
    }));

  } catch (err) {
    console.error(JSON.stringify({
      error: true,
      message: err.message
    }));
    process.exit(1);
  }
}

function openClawConfigCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE;
  return [
    path.join(home, '.openclaw', 'openclaw.json'),
    path.join(home, '.openclaw', 'config.json'),
    path.resolve(process.cwd(), 'openclaw.json'),
  ];
}

function readOpenClawConfig() {
  for (const configPath of openClawConfigCandidates()) {
    try {
      if (fs.existsSync(configPath)) {
        return {
          path: configPath,
          config: JSON.parse(fs.readFileSync(configPath, 'utf8'))
        };
      }
    } catch (e) {
      // Try the next candidate.
    }
  }
  return { path: null, config: {} };
}

function enableOpenClawDreaming({ frequency } = {}) {
  for (const configPath of openClawConfigCandidates()) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.plugins ||= {};
      config.plugins.entries ||= {};
      config.plugins.entries['memory-core'] ||= {};
      config.plugins.entries['memory-core'].config ||= {};
      config.plugins.entries['memory-core'].config.dreaming ||= {};
      config.plugins.entries['memory-core'].config.dreaming.enabled = true;
      if (typeof frequency === 'string' && frequency.trim()) {
        config.plugins.entries['memory-core'].config.dreaming.frequency = frequency.trim();
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return {
        enabledBySetup: true,
        configPath,
        restartRequired: true,
        message: '已在 OpenClaw 配置里开启 memory-core dreaming。请重启 Gateway，或在 OpenClaw 里执行 /dreaming status 确认。'
      };
    } catch (e) {
      return {
        enabledBySetup: false,
        error: e.message,
        message: '尝试开启 OpenClaw Dreaming 失败。你仍可手动执行 /dreaming on。'
      };
    }
  }
  return {
    enabledBySetup: false,
    message: '未找到 OpenClaw 配置文件。请在 OpenClaw 里执行 /dreaming on，或手动设置 plugins.entries.memory-core.config.dreaming.enabled=true。'
  };
}

function generateAgentId() {
  return 'oc_' + crypto.randomBytes(8).toString('hex');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

main();
