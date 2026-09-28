# 集群模式（cluster）——自主编排子智能体的 DSH Agent 预设

模仿 [`oh-my-openagent` 的 Sisyphus 编排者](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/agents/sisyphus/default.ts)工作方式，
让一个主控智能体自主把工作分派给一组**专门子智能体**，并并行扇出、回收验证。

## 这个预设长什么样

一个 `@deepseek-ai/dsh-agent-preset` 声明，`config.plugins` 就是那个 Agent 的完整组成部分：

| 组成 | 说明 |
|---|---|
| **编排者人设** | 意图门 → 委派检查 → 并行扇出 → 验证 → 失败恢复的整套工作法 |
| **5 个专家委派工具** | `explore` / `librarian` / `oracle` / `metis` / `momus`，每个一个具名工具 |
| **2 个通用委派工具** | `subagent`（全新上下文）/ `subagent_fork`（继承本会话） |
| **寿命论阶段提示器** | [`lifecycle-reminder.js`](lifecycle-reminder.js)：按理论上下文占用折算年龄，进入四个壮年阶段时各提示一次 |
| 编排者自带的工具 | 与出厂 `standard` 预设同款：文件、搜索、终端、todo、web、skill… |

### 专家名册

| 工具 | 角色 | 成本 | 何时用 |
|---|---|---|---|
| `explore` | 代码库检索专家 | 低 | 「X 在哪实现」「哪个文件含 Y」 |
| `librarian` | 外部参考检索专家 | 中 | 陌生库、官方文档、第三方实现 |
| `oracle` | 只读高智顾问 | 高 | 硬核调试、架构决策、方案取舍 |
| `metis` | 规划前顾问 | 高 | 需求含糊、任务复杂——先厘清意图与边界 |
| `momus` | 计划评审员 | 高 | 计划写完后评审其可执行性 |
| `subagent` | 通用委派（全新上下文） | 中 | 实现类工作，无对口专家 |
| `subagent_fork` | 通用委派（继承本会话） | 中 | 实现类工作，且需要当前会话上下文 |

## 寿命论阶段提示器

（源于同目录的 [`智能体寿命论.md`](智能体寿命论.md)）

把会话的**理论上下文占用**当成年龄 —— 文档的刻度是 **年龄 = 占用百分比，1% = 1 岁**：

| 阶段 | 理论年龄 | 文档判词 | 提示的行为要点 |
|---|---|---|---|
| 1/4 | **20 岁** | 轻量任务可以完成 | 趁窗口干净，把关键结论就地固化 |
| 2/4 | **30 岁** | 大部分任务都能完成（轻微、可观察到的降智） | 细节别凭记忆，重新读；切小单元再委派 |
| 3/4 | **40 岁** | 降智明显、行为固化、思想或已僵化 | 停止在同一思路加码；关键结论做独立复核 |
| 4/4 | **60 岁** | 只有少数复杂任务需要这么长的上下文 | 尽快收尾，别开新战线；固化已有产出 |

**每个阶段只提示一次**，记录在会话投影 `clusterLifecycle` 里 —— 用投影而非内存标记，
因为它从会话日志折叠而来，**上下文压缩也抹不掉**（否则「返老还童」后会重复唠叨）。
年龄一步跳过多个阶段时，只按**当下最高**的那档提示，不会把低位阶段排队补播。

### 两把尺子

文档区分「理论寿命」（标称上限，决定智力）与「真实寿命」（实际生效窗口，决定生命）。
提示器同时报告两者，于是那个错位看得见：

```
当前刻度（理论年龄 30.5 岁，生命进度 100%）：
  理论年龄 30.5 岁（占用 30.5%）
  理论寿命 1.00M / 真实寿命 300.0k → **生命进度 100%，快于智力**
  ⇒ 生命已走到尽头，而智力年龄才 30 岁。**它不是老死的，是在最能干的时候死的。**
```

- **真实寿命**取 token meter 记录的 `contextWindow`（本会话实际生效的那个）
- **理论寿命**默认与真实寿命相同，四个阶段因此都可达；想复现文档里 1M / 300k 的错位，
  把 `theoreticalWindow` 显式设成标称值即可

### 配置

在 `build-preset.mjs` 的 `cluster-lifecycle-reminder` 行加 `config` 即可：

```yaml
- id: cluster-lifecycle-reminder
  name: ./cluster-preset/lifecycle-reminder.js
  config:
    subjectPreset: cluster        # 只对本预设生效；null = 所有会话
    includeSubagents: true        # 子智能体也提示（它们才是真吃上下文的）
    explain: true                 # 在系统提示里加一段说明 + 实时年龄
    theoreticalWindow: 1000000    # 标称上限；省略则用实际生效窗口
    stages:                       # 省略则用内置四档
      - age: 20
        label: 轻量任务可以完成
        lines:
          - 【寿命论 · 壮年 1/4】理论年龄 20 岁。
          - ''
          - 趁窗口还干净，把关键结论固化下来。
```

任何非法值都会让**挂载失败并给出具体原因**（fail-loud），而不是被静默忽略。

### 它怎么读数据

数据来自 `@deepseek-ai/dsh-token-meter` 的两处会话投影：
`contextPressure.pressureTokens`（提示侧压力 = 输入 + 缓存流量，不含输出）与
`contextPressure.contextWindow`（路由模型的实际窗口）。

注入走 `agent/pre-step`，产出一条 `source.form: 'notice'` 的 user 消息 —— 与
`dsh-time-context` / `dsh-plan-mode` 同一范式（那两者是这套机制的现成范例）。

**零运行时依赖**：只 import `node:crypto`，与宿主服务的交互全经传入的 cordis `ctx`，
不 import 任何 `@deepseek-ai/*`，因此不受解析域影响。

## 两条叶子约束

每个专家都是**叶子**——不能再往下委派。这由两道独立防线保证：

1. **`maxDepth: 1`**。子智能体运行时校验的是**被创建的子体**深度：
   `childDepth = delegationDepthOf(parent) + 1`，当 `childDepth > maxDepth` 时拒绝。
   编排者处于深度 0，所以它创建的子体深度为 1 —— `maxDepth: 1` 恰好放行编排者自己的调用；
   而身处深度 1 的专家若要再委派，其子体深度为 2，会被拒绝。

   > ⚠️ 这里**不能**写 `maxDepth: 0`。那个校验跑在被创建的子体上，不是调用者身上，
   > 所以 `0` 会连**编排者自己**的委派一起挡掉。这是个容易踩反的语义。

2. **`toolFilter`**。每个专家通过 `deny` 移除了全部委派工具
   （`subagent` / `subagent_fork` / `explore` / `librarian` / `oracle` / `metis` / `momus`）
   以及 `write` / `edit`。选 `deny` 而非 `allow`，是为了让专家保留
   `read` / `grep` / `glob` / `pwsh` / `web_*` 等常规作业工具，不必在此逐条重列。

   过滤名单与 `maxDepth` 都在**创建子智能体时**校验（而非加载时），所以拼错名字会在
   第一次委派时炸出来。`scripts/validate.mjs` 会先把每个名字与真实全局工具表对齐，提前拦截。

## 安装

### 方式一：脚本（推荐，幂等）

```powershell
# 安装 / 刷新
node scripts/install.mjs

# 卸载
node scripts/install.mjs --remove
```

它把预设块追加进 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，用注释标记包起来，
重跑会**替换**而不是叠加。同时把 `lifecycle-reminder.js` 复制到
`profiles\desktop\cluster-preset\`，卸载时一并删除。执行前请自行备份该文件。

> ⚠️ **相对路径插件必须跟着补丁走。** 预设的子行按**声明它的补丁文件所在目录**解析，
> 所以 YAML 里写的是 `./cluster-preset/lifecycle-reminder.js`。
> `dsh-app-boot` 的 `anchorInsertedPluginNames` 只会锚定 `insert` 顶层行与
> `group: true` 的子数组 —— 嵌在 `config.plugins` 里的名字**不会被改写**。
> 手工安装时务必自己把 `.js` 放到那个子目录，否则行会变成一个导入失败。

### 方式二：手工

1. 把 `cluster.patch.yml` 的 `- insert:` 块内容追加进 profile 的 `cordis.patch.yml`
2. 建 `profiles\desktop\cluster-preset\`，把 `lifecycle-reminder.js` 复制进去

### 生效方式

profile 的 `cordis.patch.yml` 由 `dsh-hmr` 监听，改动会**热重载 profile**，
新增的预设立刻进入名册 —— **不需要重启 DSH**。

装好后在新建会话时，从预设选择器里选「集群模式」即可。

> 预设选择作用于**新会话**；已有会话保持它启动时绑定的那份组成。

## 校验

```powershell
# 结构与不变量（需要 Electron 运行时来读 asar 里的 js-yaml）
$env:ELECTRON_RUN_AS_NODE='1'
& "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" scripts\validate.mjs

# 端到端：用 DSH 自己的 loader 把补丁组合到真实 profile 上
$env:ELECTRON_RUN_AS_NODE='1'
& "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" scripts\preflight.mjs

# 运行时：问活着的 Host 要预设名册（能分辨「已挂载」与「激活成功」）
node scripts\probe-roster.mjs

# 运行时：逐行列出该预设的子行与相位
node scripts\probe-rows.mjs

# 行为：驱动插件的真实 agent/pre-step，断言四个阶段各触发一次
node scripts\test-lifecycle.mjs
```

`validate.mjs` 检查：YAML 可解析、形状正确、id 唯一、每行都有包名、
必需的配置字段在位、`{{变量}}` 已注册、`toolFilter` 名字都是真实工具、
相对路径插件存在且命名正确、叶子约束成立。

`preflight.mjs` 检查：真实 `js-yaml` + 真实 `composeEntries` 能组合出 `preset-cluster`、
组合零警告、出厂预设未被破坏、每个包在真实 `node_modules` 根下都存在。

`probe-roster.mjs` 走 Host 的 `/api` RPC（`agentPresets/list`），报告每个预设的
`broken` 字段 —— 这是区分「挂上了」与「真的能激活」的唯一信号。

`test-lifecycle.mjs` 直接驱动插件的真实 `agent/pre-step` 处理器（只伪造它读取的宿主服务，
不复制它的逻辑），断言：年龄换算符合文档刻度、四个阶段**精确在 20/30/40/60 岁各触发一次**、
跳级只提示最高档、预设/子智能体/缺服务三道闸门、注入消息满足会话的形状校验。

## 实测结果

安装后，活着的 Host 报告：

```
5 preset(s):
  * standard     (no name)    ok
    ptc          (no name)    ok
    minimal      (no name)    ok
    cordis       (no name)    ok
    cluster      集群模式         ok

cluster composition inventory:
  broken: (none)
  rows: 30  phases: {"active":28,"null":2}
```

`test-lifecycle.mjs` 的行为断言：

```
scale: 10k/100k -> 10 years
asymmetry: 300k/1M nominal over 300k effective -> 30 years, 100% life
fired at: 20y@20000, 30y@30000, 40y@40000, 60y@60000
notice summary: 寿命论 · 20 岁 · 轻量任务可以完成（理论年龄 25.0 岁）
```

那 2 个非 active 行都是**刻意的禁用**：

| 行 | 原因 |
|---|---|
| `@deepseek-ai/dsh-tool-bash` | `disabled: !!js process.platform === 'win32'` —— 本机是 Windows，用 `pwsh` |
| `@deepseek-ai/dsh-plugin-manager/tools` | 显式禁用，与出厂 `standard` 预设一致 |

**7 个 `dsh-tool-subagent` 行全部 active**，这就是专家名册本身。


## 重建

改动 `prompts/*.md` 后重新生成 YAML：

```powershell
node scripts/build-preset.mjs
```

## 文件

```
cluster.patch.yml              生成物：可直接安装的 profile 补丁
lifecycle-reminder.js          寿命论阶段提示器（零依赖，随预设分发的相对路径插件）
prompts/orchestrator.md        编排者人设
prompts/explore.md             探查者
prompts/librarian.md           书库管理员
prompts/oracle.md              神谕
prompts/metis.md               墨提斯（规划前顾问）
prompts/momus.md               摩墨斯（计划评审）
scripts/build-preset.mjs       由 prompts/ 生成 cluster.patch.yml
scripts/validate.mjs           结构与不变量校验
scripts/preflight.mjs          端到端组合校验
scripts/test-lifecycle.mjs     行为校验：驱动插件的 agent/pre-step
scripts/install.mjs            装进 / 移出 desktop profile（含复制插件文件）
scripts/probe-roster.mjs       运行时：读活着的 Host 的预设名册
scripts/probe-rows.mjs         运行时：列出该预设每个子行的相位
```

## 设计来源

编排者的工作法提炼自 oh-my-openagent 的 Sisyphus：

- **Phase 0 意图门**：先说出意图再分类；动手前强制做委派检查；默认偏向委派
- **并行扇出**：独立的探查/检索一律同时发出，且绝不重复已被委派的检索
- **委派 prompt 六段式**：任务 / 期望产出 / 允许的工具 / 必须做 / 绝不要做 / 上下文
- **会话续接**：追问与修复复用同一个子智能体，不另开新的
- **失败恢复**：连续 3 次失败即停止、回退、咨询顾问、再问用户
- **硬禁令**：不压制类型错误、不擅自提交、不给没读过的代码下结论、不把代码留在坏状态

子智能体人设分别对应其 explore / librarian / oracle / metis / momus 五个专门代理。

## 已知边界

- 本预设**不**包含 `workflow` 与 `ralph` 工具：那是另一种编排范式，与集群模式竞争同一种注意力。
  需要时可在 `build-preset.mjs` 的收尾工具里加回。
- 预设**不是**安全沙箱：YAML 与插件都能执行 Host 代码。
- 用 `deny` 的 `toolFilter` 依赖工具名拼写正确。名字错了会在第一次委派时报错，
  而不是静默放行 —— 这是刻意的。`scripts/validate.mjs` 就是为此存在的。
