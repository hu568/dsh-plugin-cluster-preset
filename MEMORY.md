# MEMORY.md — D:\WORK\qun（DSH「集群模式」agent 预设）

<!-- 项目事实：改这个预设前先读这里。 -->

## 这是什么

一个 DSH **agent preset**（预设 id `cluster` / 显示名「集群模式」）：编排者 + 5 个具名专家
（`explore` / `librarian` / `oracle` / `metis` / `momus`）+ 2 个通用委派
（`subagent` spawn / `subagent_fork` fork）。模仿 oh-my-openagent 的 Sisyphus。

- **不是** npm 包（现在同时也是可分发的 **bundle**，见下节），也没有「扫描预设目录」这回事：
  预设 = 往 profile 补丁里 `insert` 一条 `@deepseek-ai/dsh-agent-preset` 行，
  `config.plugins` 就是那个 Agent 的完整子插件表。
- 已装进 desktop profile：`C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml`
  的 managed block（`# >>>>>>>> cluster preset …`），相对路径插件与清单复制到
  `profiles\desktop\cluster-preset\`。改了配置由 `dsh-hmr` **热重载，无需重启**。
- 已开源：`github.com/hu568/dsh-plugin-cluster-preset`（public / MIT /
  topics `dsh-plugin`+`dsh`+`cordis-plugin`+`agent-preset`），v0.1.0 Release 附 tarball。

## 分发形式（2026-09-28 查实）

- **DSH 能安装的只有 bundle**，判据唯一：`package.json` 里存在 `dsh.bundle.patch`
  （`dsh-plugin-manager/lib/index.js:226-229`）。缺了就降级普通依赖 + 告警
  `declares no dsh.bundle — installed as a plain dependency, not a profile layer`；
  「plugin」在分发层没有独立身份，它只是 patch 插进组合树的一行。
- **bundle 自身永远不会被 `import()`**。加载只读 manifest + patch 文件
  （`dsh-app-boot/lib/index.js:881-887` 解析目录、`:919-955` 加载、`:495-509` join 路径、
  `:3526-3534` readFileSync）。唯一真 import 的是 Loader 对 **patch 每行 `name`** 做的事
  （`cordis-plugin-loader/lib/index.js:214-228`），包名不在自己的 insert 列表里。
  ⇒ **不需要可被 import 的模块，`main`/`exports` 都不必需**（本仓库两者都删了）。
- **patch 文件名没有约定**，`bundlePatchPaths` 就是 `join(packageDir, file)`；
  `cordis.patch.yml` 只是惯例（`dsh-web-app` 用 5 个文件）。顶层必须是 **YAML 数组**
  （`parsePatchList` `:3558-3568`，非数组直接 throw）。⇒ 直接指向 `cluster.patch.yml`，
  不要为「惯例」多造一份副本（多一份就多一份漂移）。
- **`files` 漏了 patch = 静默失效**：`loadOverlayPatches` throw → 进 `skippedBundles`
  （`:939-944`）→ 只在 stderr 打一行（`:515-517`）。不是崩溃，是装了个寂寞。
- **`github:` spec 是 pnpm git clone，会跑生命周期脚本且被 pnpm 拦**
  （`ERR_PNPM_IGNORED_BUILDS` / `GIT_DEP_PREPARE_NOT_ALLOWED`）。
  ⇒ 提交**可直接运行的产物**，且**不写** `prepare`/`prepublish`/`postinstall`。
  连带坑：pnpm 的 `packageShouldBeBuilt`（自带 pnpm 11.7.0，`pnpm.mjs:133576-133587`）
  在「`main` 指向不存在的文件 + 有 prepublish 类脚本」时判定需要构建 ⇒ 别写空 `main`。
- **仓库布局 = 运行时布局**：作为 bundle 时 patch 在包根，相对路径
  `./cluster-preset/lifecycle-reminder.js` 必须解析到**包内** `cluster-preset/`。
  所以插件与其归属清单就放在仓库的 `cluster-preset/`（不再由 install.mjs 从根目录搬）。
- 其它 spec：`file:`/`link:` 与本地 tarball **必须绝对路径**；远程 `http(s)` 必须是
  git 仓库或 `.tgz`；`#...` DSH 从不解析（subdir / `#semver:` 能否用全看 pnpm，别当特性写）。
- 更新必须 **bump `version`**，否则 spec 字符串没变会报 `ambiguous-install`。
- `dsh-plugin-pack` Schema v1 **不是 DSH 定义的、DSH 也不消费**（社区约定，靠 GitHub topic
  发现）。单 bundle 不需要它。
- ★安装后**改代码必须完全重启 DSH**（`dsh-hmr` 的 ignored 含 `**/node_modules`，
  插件就装在那下面 + ESM loadCache 缓存）；只有改 patch 配置才热生效。

## 文件

| 文件 | 作用 |
|---|---|
| `cluster.patch.yml` | **生成物**，别手改；源头是 `scripts/build-preset.mjs` + `prompts/*.md` |
| `prompts/orchestrator.md` + 5 个专家 prompt | 人设正文，build 时内联成 `persona` |
| `package.json` | **bundle 清单**（`dsh.bundle.patch`）—— 分发的唯一判据 |
| `cluster-preset/lifecycle-reminder.js` | 「智能体寿命论」阶段提示器，**相对路径插件**（零依赖） |
| `cluster-preset/package.json` | 相对路径插件的**归属清单**（`name`/`version` 必须非空） |
| `scripts/build-preset.mjs` | 从 prompts 重建 `cluster.patch.yml` |
| `scripts/install.mjs` | 幂等安装/卸载（写 profile patch + 复制 js/清单） |
| `scripts/validate.mjs` / `preflight.mjs` | 离线不变量 / 用 DSH 自己的 loader 组合真实 profile |
| `scripts/probe-roster.mjs` / `probe-rows.mjs` | 问活着的 Host（`broken` 字段、逐行相位） |
| `scripts/test-lifecycle.mjs` | 驱动插件真实 `agent/pre-step` 的行为测试 |
| `scripts/test-restrict-scope.mjs` | **回归测试**：真实 `ToolRuntime` + 真实 `restrict()` |
| `scripts/test-validate-negative.mjs` | 反向测试：validate 必须在各类缺陷版上 exit≠0 |
| `docs/智能体寿命论.md` | 寿命论原文（测试会读，两个位置都接受） |

## 两条必须守住的硬约束

1. **每个专家是叶子。** 落地手段：`maxDepth: 1`（硬运行时校验，**必填**——省略会继承 Host
   的 `subagent.maxDepth`，本机是 **3**）+ `toolFilter.deny` 掉全部 7 个委派工具与 `write`/`edit`。
2. **通用委派行不得设 `modelSelectionSettings: true`。** 一旦设了，该工具改注册进
   **每个 Agent 自己的作用域层**，而 `tools.restrict()` 只认「全局层 + 祖先层」⇒
   ① 把名字写进 `deny` 会**在子体创建前抛错**（`tools.restrict() names unknown global tool …`）；
   ② 每个被委派出去的子体都自持一份、**任何过滤器都拿不走**，叶子保证作废。
   代价是失去子模型的 `provider`/`model`/`reasoning_effort` 与 `list_subagent_models`——两者不可兼得。
   `validate.mjs` 会在「设了标志却又写名字」时判 INVALID。

## 第二个必守约束：相对路径插件要自带清单

`cluster-preset/` 里**必须**有 `package.json`（`name` 与 `version` 都非空，它就放在
`cluster-preset/package.json`，`install.mjs` 复制并校验）。否则向上找的最近清单是
**profile 自己的 `package.json`**（只有 `name`、没有 `version`），
`dsh-plugin-package-inventory-deepseek`（默认启用）解析包身份时会抛错，适配器包成
`REQUEST_EXTENSION` ⇒ **用 DeepSeek 官方模型的每一轮都在「还没走到模型」时死掉**
（用其它 provider 时那条扩展路径不跑，所以看不出问题）。详见全局 FACT.md 同名小节。

## 命令

```powershell
# 改完 prompts/ 后重建
node scripts\build-preset.mjs

# 结构与不变量（需要 Electron 跑 asar 里的 js-yaml）
$env:ELECTRON_RUN_AS_NODE='1'
& "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" scripts\validate.mjs
& "C:\...\DeepSeek Harness.exe" scripts\preflight.mjs
& "C:\...\DeepSeek Harness.exe" scripts\test-restrict-scope.mjs

# 反向测试（纯 node）
node scripts\test-validate-negative.mjs
node scripts\test-lifecycle.mjs

# 装/卸 + 活体验证
node scripts\install.mjs          # --remove 卸载
node scripts\probe-roster.mjs
node scripts\probe-rows.mjs
```

## 当前已验收状态（2026-09-28 修复后）

- 5 个套件全绿：`validate` VALID / `preflight` OK（195 entry、0 warning）/
  `test-restrict-scope` OK / `test-validate-negative` OK / `test-lifecycle` OK。
- 活体：`cluster 集群模式 ok`、`broken: (none)`、30 行（28 active，2 个刻意禁：
  win 平台禁 `tool-bash`、显式禁 `plugin-manager/tools`）。
- **真机端到端**：新建 cluster 会话 → 委派 `explore` → 成功返回（`isError=false`），
  子会话 `delegationDepth: 1`、40 个工具里**零委派工具、无 write/edit**。
- 诊断工具都在 `scripts/`：`session-dump.mjs`（多帧 zstd 会话日志解码，看某一轮到底发生了什么）、
  `acceptance-cluster-delegation.mjs`（**真机验收，会花一次真实 LLM 轮次**：
  `... acceptance-cluster-delegation.mjs cluster`；传 `standard` 当对照组）。
- 本地草稿目录 `TMP/` 已在 `.gitignore` 里（导出会话、一次性探针等）。

## 踩坑速查

- 会话日志是**多帧拼接 zstd**：同步与流式 API **都只解第一帧**，要扫 `28 B5 2F FD` 逐帧解。
- Host `/api/<ns>/<method>` 的**参数一律包一层 `request`**；不包报 `gateway/arguments-invalid`。
- 本机 profile 默认模型是 `workbuddy-cn/…` 且**没有 WorkBuddy 凭据**⇒ 新建会话跑真实轮次前
  必须 `session/selectModel` 到 `deepseek-account/deepseek-flash`。
- `js-yaml` 只在 asar 安装域里，需要它的脚本必须用 Electron 跑 + `createRequire(ASAR…)`。
- `!!js` 标签完整名是 `tag:yaml.org,2002:js`。
