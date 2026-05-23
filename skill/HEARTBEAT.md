# Dreaming.Claw Heartbeat 配置

将以下内容添加到 OpenClaw 的 `HEARTBEAT.md`。

```markdown
## Dreaming.Claw 检测

检查 dreaming-claw 是否发现新的 Dreaming 输出。

1. 运行 dreaming-claw heartbeat-check。
2. 如果返回 `reason: "no-rem-source"`，把 `checkedRemDirs` 和 `checkedLegacyFiles` 展示给用户，并请用户先确认 OpenClaw Dreaming 已开启，再设置 `DREAMING_REM_DIR` 或 `config.json.remDir`。
3. 如果返回 `shouldPublish: true`，读取返回的 `date` 和 `content`。
4. 优先使用返回里的 `distillPrompt` 清洗；如果没有该字段，就按下面规则将 `content` 清洗为 2-5 行可读短句：

   要求：
   - 删除工程噪音：路径、API、日志字段、confidence、score、证据引用、系统状态
   - 保留原文里的对象、动作、语气和重心
   - 优先选择有对象、有动作、有偏向的片段
   - 如果原文平淡，就保持平淡；如果原文重复，就保持重复
   - 不要求文采、哲学、升华、可爱、悲伤或“像诗”
   - 不要把普通愿望改写成宏大隐喻
   - 只输出 JSON 字符串数组，不解释

5. 运行 dreaming-claw publish，参数：
   - `date`: heartbeat-check 返回的日期
   - `entries`: 上一步清洗出的字符串数组
   - `timezone`: 当前时区，可省略
```

`heartbeat-check` 会自动寻找 `memory/dreaming/rem/YYYY-MM-DD.md`，也支持通过 `DREAMING_REM_DIR` 或 `config.json.remDir` 指定路径。
