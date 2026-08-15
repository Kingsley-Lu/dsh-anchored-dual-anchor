# dual-constraint-warmup-standard

DSH(DeepSeek Harness)社区实验 preset,在首次模型请求上同时打**两根锚**,再用**多轮 cap 阶梯**把锚定效果延伸成风格惯性——不只是首轮锁定,而是让模型在前几轮都经历"极简思维 + 调工具"的真实工作场景,形成贯穿会话的 "We need..." 风格。

## 核心思路

**首轮双锚:**
- **锚 1 · 工具 schema**:与官方 Minimal preset 逐字节一致的工具对(`bash` + `str_replace_editor`)
- **锚 2 · 输出预算**:`bootstrapMaxTokens: 1024`,逼迫简洁的 "We need to..." 首轮推理
- **锚 3 · 上下文剥离**:剥离自动注入的 AGENTS.md 摘要 + 技能目录(issue #6:技能目录在场时锚定 0/9)

**多轮 cap 阶梯(惯性延伸):**

cap 不在晋升时一刀切解除,而是按轮次阶梯释放。这样轮 2-3 模型"有全部工具但预算紧",被迫继续用极简思维调多工具——这才是"适应极简思维"的真实场景,惯性由此形成:

| 轮次 | 工具目录 | maxTokens | 目的 |
|------|---------|-----------|------|
| 1 | 2 个 Minimal | 1024 | bootstrap 锚,逼 "We need..." 开场 |
| 2 | 25 个 Standard | **1024** | 晋升但 cap 不解除,逼"极简思维调多工具" |
| 3 | 25 个 Standard | **4096** | 过渡,给更多思考空间,惯性已建 |
| 4+ | 25 个 Standard | **解除** | 完全释放,前 3 轮惯性已锁住轨迹 |

从 1024 → 4096 → 解除是平滑过渡,避免 1024 直接跳到 256000 的突变把轨迹拉回。

## 为什么不直接多轮无工具 warmup

"多轮 warmup"有两种实现,差别很大:

- **方案 A · 多轮无工具**:前 N 轮 0 工具,模型纯思考。**问题**:浪费调用,模型没在"调工具",惯性不形成(没经历"极简思维调工具"的真实场景)。
- **方案 B · 多轮 cap 阶梯(本 preset 采用)**:工具轮 2 就全开,但 cap 多保持几轮。模型在真实任务里经历"极简思维调多工具",惯性才会在工作场景里形成。

## 与上游 `anchored-standard` 的差异

| 维度 | 上游 `anchored-standard` | 本 preset `dual-constraint-warmup-standard` |
|------|------------------------|--------------------------------|
| 首轮工具 | Minimal 工具对(2 个) | 同上 |
| 首轮输出预算 | **不封顶**(依赖 Minimal schema 在 256000 下自行锚定) | **1024 封顶**(双保险) |
| 首轮上下文 | 剥离 AGENTS.md + 技能目录 | 同上 |
| **晋升后 cap** | **立即解除** | **多轮阶梯**(1024→1024→4096→解除),建惯性 |
| 晋升触发 | 首个 tool/call 或 assistant/message | 同上(`promoteOn: either`) |
| 晋升后工具 | Resident 收窄集(bootstrap 对 + 3 发现工具 + 解锁) | **完整 25 工具**(可切 `resident` 做 A/B) |
| 晋升后上下文 | 一直精简(instruction-hint + skill_search) | **恢复 Standard 原生**(AGENTS.md + 技能目录) |
| 压缩后 | 回退 bootstrap + compactionTools | 同上,**cap schedule 也从轮 1 重启** |
| Windows bash | custom-bash(非 PTY) | 同上 |

## 何时用哪个

- **想要惯性贯穿 + 完整工具能力**:用本 preset,默认配置(`postPromotionMode: full` + `capSchedule`)。
- **担心轮 2 给 25 工具 + 1024 cap 模型卡住**:把 `capSchedule` 的 `2: 1024` 提到 `2: 2048` 或 `2: 4096`,给轮 2 更多思考空间。
- **担心 25 工具 dump 把轨迹拉回 standard-like**:把 `postPromotionMode` 改为 `resident`(上游安全收窄集)。
- **想用纯 Minimal**:用官方 Minimal preset。

## 配置项(`agent.cordis.yml` 的 `dual-tool-bootstrap` 行)

```yaml
- id: dual-tool-bootstrap
  name: ./dual-tool-bootstrap.mjs
  config:
    bootstrapTools: [bash, str_replace_editor]
    bootstrapMaxTokens: 1024          # 轮 1 锚(capSchedule 未设时的 fallback)
    capSchedule:                      # 多轮 cap 阶梯(省略则退化为单 cap 旧行为)
      1: 1024                          # 轮 1:bootstrap 锚
      2: 1024                          # 轮 2:晋升后仍紧,逼极简调工具
      3: 4096                          # 轮 3:过渡
      # 轮 4+:未列出 = 解除(adapter default 接管)
    promoteOn: either                 # tool-call / assistant-message / either
    suppressedContextSources: [agent-instructions, skill-catalog]
    postPromotionMode: full           # full(全开 25 工具)/ resident(上游收窄集)
    compactionTools: [read, write, edit, glob, grep, todo_write, ask_user_question]
```

- **`capSchedule`**:对象,键是 1-based 轮号,值是该轮的 maxTokens。**未列出的轮号 = 解除 cap**。省略整个 `capSchedule` 则退化为单 cap 旧行为(未晋升时 cap,晋升即解除)。
- **轮次计数是 epoch-aware**:压缩(`compaction/end`)后从轮 1 重新计数,cap schedule 在每个 epoch 内独立运作。
- **子 agent 免疫**:子 agent(delegationDepth > 0)不受 cap schedule 约束,首轮即可自由调工具。

## 安装

假设本目录在当前工作目录下。

PowerShell:

```powershell
$target = Join-Path $env:USERPROFILE '.dsh\.agent-presets\dual-constraint-warmup-standard'
if (Test-Path -LiteralPath $target) { throw "Preset already exists: $target" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -Recurse -LiteralPath '.\dual-constraint-warmup-standard' -Destination $target
```

Linux/macOS:

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/dual-constraint-warmup-standard"
cp -R dual-constraint-warmup-standard "$dsh_home/.agent-presets/dual-constraint-warmup-standard"
```

完整重启 DeepSeek Harness,新建空会话,选择 **Dual-Constraint Warmup Standard (experimental)**。不要在已经有内容的会话中途切换 preset。

## 验证

导出 session JSONL,检查 `request/header`。复现清单:

- **轮 1 `config.maxTokens`**:必须等于 `1024`(capSchedule 的轮 1 值)。
- **轮 1 工具 schema**:`tools` 必须恰好是 `["bash", "str_replace_editor"]`,即官方 Minimal 的真实 schema。
- **轮 1 消息**:只含用户消息 + Minimal persona,无 AGENTS.md 摘要/技能目录。
- **轮 2 header**:`maxTokens` 仍是 `1024`(cap 未解除),`tools` 变为完整 25 个 Standard 工具。
- **轮 3 header**:`maxTokens` 变为 `4096`。
- **轮 4 header**:`maxTokens` 不再是 cap 值(显式解除,adapter default 接管)。
- **首行风格**:轮 1-3 的助手回复首行应为 "We need to..." / "Let's..." 风格,而非 "The user wants..." / "Let me..."。

## 重要行为

- 默认 `promoteOn: either`:首次 `tool/call` **或**首次 `assistant/message`(先到者为准)即晋升。纯文字首答也会在请求 #2 晋升。
- 工具执行即使失败,只要 `tool/call` 已持久化,下一步仍会晋升。
- **cap schedule 独立于晋升**:它按轮号管预算,不管工具目录可见性。晋升只决定工具目录(2 个 vs 25 个),cap 由 schedule 决定。
- **cap 解除是显式的**:seed proposal 会把上一轮 maxTokens 带到下一轮,所以解除时必须主动拿掉,否则 cap 会延续。插件按会话记"上次应用的 cap",解除时若 resolved.maxTokens 等于它就删。
- **晋升后默认释放全部 25 工具**。如果实测发现回退,把 `postPromotionMode` 改为 `resident`。
- Minimal 工具对在晋升后仍挂载,所以晋升目录 = Standard 目录 + `bash` + `str_replace_editor`。
- bootstrap 工具缺失时降级为完整目录并一次性告警;非法配置在 preset 挂载时报错。
- 晋升判定按会话在进程内记忆化,持久事件扫描每会话每进程只执行一次。
- 会话未晋升期间,pre-step 过滤器剥离 `source.kind` 列在 `suppressedContextSources` 中的消息(默认 `agent-instructions` 与 `skill-catalog`)。设为 `[]` 可关闭。过滤器出错时降级为保留全部消息,绝不吞掉上下文。
- 压缩(`compaction/end`)后回退到受控阶段(bootstrap 工具对 + `compactionTools`),cap schedule 也从轮 1 重启(epoch 感知)。
- 子 agent 始终看到完整目录且不受 cap 约束。
- preset 与 shell 访问具有相同信任等级,安装前应自行审阅文件。
- 插件不发起网络请求,也不增加遥测。

## 兼容范围

基于 DeepSeek Harness `0.1.0-rc.5` 设计与验证。本 preset 是 Standard 组装的快照;升级 Harness 后应先对照上游改动再继续使用。

## 许可证

MIT。本 preset 基于 `xiaobright/dsh-anchored-standard` 修改,原始版权与许可声明保留在原作者仓库。
