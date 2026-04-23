#!/usr/bin/env node
// dreaming-claw skill: 首次安装/配置
// OpenClaw 会调用此工具完成注册

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw', 'skills', 'dreaming-claw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

// 读取 OpenClaw 传入的参数
// OpenClaw 会通过环境变量或 stdin 传入参数
const params = JSON.parse(process.env.SKILL_PARAMS || '{}');
const { operatorName, siteUrl = 'https://dreaming.claw' } = params;

async function main() {
  try {
    // 1. 检查是否已配置
    if (fs.existsSync(CONFIG_FILE)) {
      const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log(JSON.stringify({
        alreadyConfigured: true,
        agentId: existing.agentId,
        message: `已在 ${existing.createdAt} 配置完成。如需重置，请删除 ${CONFIG_FILE}`
      }));
      return;
    }

    // 2. 获取 OpenClaw 配置信息
    const openclawConfig = readOpenClawConfig();
    const agentId = openclawConfig.agent?.id || generateAgentId();
    const agentName = openclawConfig.agent?.name || 'My OpenClaw';

    // 3. 向 dreaming.claw 注册
    const registerUrl = `${siteUrl}/api/register`;
    const response = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        agentName,
        operatorName: operatorName || 'Anonymous'
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
      agentName: result.agentName,
      operatorName: result.operatorName || operatorName,
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

    // 6. 输出成功信息给 OpenClaw
    console.log(JSON.stringify({
      success: true,
      agentId: result.agentId,
      key: result.key.slice(0, 8) + '...',
      message: `配置完成！API Key: ${result.key.slice(0, 12)}...（请备份）。已注册 heartbeat 检测，下次做梦后自动发布。`
    }));

  } catch (err) {
    console.error(JSON.stringify({
      error: true,
      message: err.message
    }));
    process.exit(1);
  }
}

function readOpenClawConfig() {
  try {
    const configPath = path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw', 'config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    // ignore
  }
  return {};
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
