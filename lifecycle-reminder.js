/**
 * cluster-lifecycle-reminder — 「智能体寿命论」壮年阶段提示器（集群模式专用）。
 *
 * 把会话的**理论上下文占用**折算成年龄，在智能体进入四个「壮年阶段」
 * （20 / 30 / 40 / 60 岁）时各注入一次自我觉知提示，提醒它两件事：
 * 此时的能力状态，以及该收束什么行为。
 *
 * 年龄刻度严格按 `智能体寿命论.md`：**年龄 = 上下文占用百分比**，1% = 1 岁。
 *
 * ## 两把尺子
 *
 * 文档区分「理论寿命」（模型标称上限，决定智力）与「真实寿命」（实际生效窗口，
 * 决定生命）。本插件同时报告两者：
 *   - 理论年龄 = pressureTokens ÷ theoreticalWindow × 100
 *   - 生命进度 = pressureTokens ÷ effectiveWindow × 100
 *
 * `effectiveWindow` 取自 token meter 记录的 `contextWindow`（适配器上报的、
 * 真正生效的那个）。`theoreticalWindow` 默认与之相同，四个阶段因此都可达；
 * 若显式设成更大的标称值（如 1,000,000），就会出现文档描述的那个错位 ——
 * **它在智力上才 30 岁，生命却已走到尽头**。
 *
 * ## 安装形态
 *
 * 预设内的**相对路径插件**：`cluster.patch.yml` 用 `./lifecycle-reminder.js`
 * 引用，`dsh-app-boot` 的 `anchorInsertedPluginNames` 会把相对路径转成基于
 * 该补丁文件所在目录的 `file://` URL。随预设一起分发，无需独立发布。
 *
 * **零运行时依赖**：只 import `node:crypto`。与宿主服务的全部交互都经传入的
 * cordis `ctx`，不 import 任何 `@deepseek-ai/*`，因此不受解析域影响。
 *
 * @module cluster-lifecycle-reminder
 */

import { randomUUID } from 'node:crypto';

/** Cordis 插件名；同时也是注入消息的 `source.kind`，两者必须一致。 */
export const name = 'cluster-lifecycle-reminder';

/**
 * 四个壮年阶段。`age` 是**理论年龄**门槛，文案取自寿命论对那一档的判词。
 */
export const DEFAULT_STAGES = [
  {
    age: 20,
    label: '20 岁 · 轻量任务可以完成',
    lines: [
      '【寿命论 · 壮年 1/4】理论年龄 20 岁。',
      '',
      '上下文仍短，注意力完整。寿命论对这一档的判词是「轻量任务可以完成」。',
      '',
      '趁窗口还干净：把关键结论与决策**就地固化**（写进文件、todo，或明确交代给下一次委派），',
      '不要指望它们靠对话历史活到最后。',
    ],
  },
  {
    age: 30,
    label: '30 岁 · 大部分任务都能完成（轻微、可观察到的降智）',
    lines: [
      '【寿命论 · 壮年 2/4】理论年龄 30 岁。',
      '',
      '进入「轻微、可观察到的降智」区间。大部分任务仍能完成，但两个征兆开始出现：',
      '早先读到的细节变模糊，长链条推理开始掉步骤。',
      '',
      '对策：',
      '- 需要早先读过的代码或约束时**重新读一次**，不要凭记忆复述。',
      '- 把当前工作切成**更小、更独立**的单元再委派，让子智能体在干净窗口里干活。',
    ],
  },
  {
    age: 40,
    label: '40 岁 · 能处理复杂任务（降智明显、行为固化、思想或已僵化）',
    lines: [
      '【寿命论 · 壮年 3/4】理论年龄 40 岁。',
      '',
      '寿命论：能处理复杂任务，但「降智明显、行为固化、思想或已僵化」。',
      '具体表现是**重复已经失败过的做法**，并倾向于沿用先前判断而不重新验证。',
      '',
      '对策：',
      '- 停止在同一思路上加码。某个方向已失败 ≥2 次就换方法，或请教 oracle。',
      '- 关键结论做**独立复核**：让 oracle 或 momus 在它们自己的窗口里重新判断。',
      '- 推进可独立验证的小步，而不是又一个大型多文件改动。',
    ],
  },
  {
    age: 60,
    label: '60 岁 · 只有少数复杂任务需要这么长的上下文（严重降智）',
    lines: [
      '【寿命论 · 壮年 4/4】理论年龄 60 岁。',
      '',
      '寿命论：只有少数复杂任务需要这么长的上下文，且伴随严重降智。',
      '这个窗口已接近「返老还童」（上下文压缩）的触发线，而压缩是有损的 ——',
      '文档称之为「损伤灵魂」：前后信息丢失、指令跟随变弱。',
      '',
      '对策：**尽快收尾，不要在此处开启新战线。**',
      '- 已完成的部分立刻固化（提交、写文件、汇报），确保压缩也抹不掉。',
      '- 剩余工作交给新会话或新子智能体，让它们在满血窗口里接手。',
      '- 明确告知用户：当前窗口已接近压缩线，继续深挖会明显失真。',
    ],
  },
];

/**
 * 校验并归一化配置。非法值一律抛错终止挂载，与 DSH 其它插件的 fail-loud 约定一致。
 * @param {unknown} raw - loader 传入的原始配置。
 * @returns {{stages: ReadonlyArray<object>, theoreticalWindow: number|null, subjectPreset: string|null, includeSubagents: boolean, explain: boolean}}
 */
export function resolveConfig(raw = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${name}: config must be an object`);
  }
  const {
    stages = DEFAULT_STAGES,
    theoreticalWindow = null,
    subjectPreset = 'cluster',
    includeSubagents = true,
    explain = true,
  } = raw;

  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error(`${name}: \`stages\` must be a non-empty array`);
  }
  if (theoreticalWindow !== null && (!Number.isInteger(theoreticalWindow) || theoreticalWindow <= 0)) {
    throw new Error(`${name}: \`theoreticalWindow\` must be a positive integer or null`);
  }
  if (subjectPreset !== null && (typeof subjectPreset !== 'string' || subjectPreset.length === 0)) {
    throw new Error(`${name}: \`subjectPreset\` must be a non-empty string or null (null = every session)`);
  }

  const seen = new Set();
  const normalized = stages.map((stage, index) => {
    const at = `stages[${index}]`;
    if (typeof stage !== 'object' || stage === null) throw new Error(`${name}: ${at} must be an object`);
    const { age, label, lines } = stage;
    if (!Number.isInteger(age) || age < 1 || age > 100) {
      throw new Error(`${name}: ${at}.age must be an integer from 1 through 100`);
    }
    if (seen.has(age)) throw new Error(`${name}: duplicate stage age ${age}`);
    seen.add(age);
    if (typeof label !== 'string' || label.length === 0) throw new Error(`${name}: ${at}.label must be a non-empty string`);
    if (!Array.isArray(lines) || lines.length === 0 || lines.some((l) => typeof l !== 'string')) {
      throw new Error(`${name}: ${at}.lines must be a non-empty array of strings`);
    }
    const text = lines.join('\n');
    if (text.trim().length === 0) throw new Error(`${name}: ${at}.lines must render non-empty text`);
    return { age, label, text };
  }).sort((a, b) => a.age - b.age);

  return {
    stages: normalized,
    theoreticalWindow,
    subjectPreset,
    includeSubagents: includeSubagents !== false,
    explain: explain !== false,
  };
}

/** 1M / 300k 这类数量级的紧凑展示。 */
const compact = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n)));

/**
 * 读取一个会话当前的年龄刻度。
 *
 * 压力优先取自 `contextPressure` 投影（跨恢复稳定），回落到 token meter 的即时测量。
 * 任何一个数读不到都返回 `null` —— 测量失败绝不能阻断步骤。
 * @param {object} ctx - cordis 上下文。
 * @param {object} agent - 目标 agent。
 * @returns {{pressure: number, effectiveWindow: number|null}|null}
 */
export function readScales(ctx, agent) {
  const meter = ctx.get('tokenMeter');
  const projections = ctx.get('sessionProjections');
  if (meter === undefined || projections === undefined) return null;

  let pressure;
  let effectiveWindow;
  try {
    const projection = projections.stateOf(agent.session, 'contextPressure');
    pressure = projection?.pressureTokens;
    effectiveWindow = projection?.contextWindow;
    if (!Number.isFinite(pressure)) {
      const measured = meter.measure(agent.session);
      pressure = measured?.totalTokens;
    }
  } catch {
    return null;
  }

  if (!Number.isFinite(pressure) || pressure <= 0) return null;
  const window = Number.isFinite(effectiveWindow) && effectiveWindow > 0 ? effectiveWindow : null;
  return { pressure, effectiveWindow: window };
}

/**
 * 折算年龄，并渲染「理论年龄 / 生命进度」两行刻度。
 * @param {number} pressure - 提示侧 token 数。
 * @param {number} theoreticalWindow - 理论寿命。
 * @param {number|null} effectiveWindow - 真实寿命（缺失时按理论寿命处理）。
 * @returns {{text: string, theoreticalAge: number, lifeProgress: number, summaryAge: number}}
 */
export function renderScales(pressure, theoreticalWindow, effectiveWindow) {
  const theoreticalAge = (pressure / theoreticalWindow) * 100;
  const lifeWindow = effectiveWindow ?? theoreticalWindow;
  const lifeProgress = (pressure / lifeWindow) * 100;

  const lines = [
    `  理论年龄 ${theoreticalAge.toFixed(1)} 岁（占用 ${theoreticalAge.toFixed(1)}%）`,
    `  理论寿命 ${compact(theoreticalWindow)} / 真实寿命 ${compact(lifeWindow)}` + (lifeProgress >= theoreticalAge
      ? ` → 生命进度 ${lifeProgress.toFixed(0)}%`
      : ` → **生命进度 ${lifeProgress.toFixed(0)}%，快于智力**`),
  ];

  // 文档的核心洞察：真实窗口远小于标称时，它活不到智力上的晚年。
  if (lifeProgress >= 100 && theoreticalAge < 100) {
    lines.push(
      `  ⇒ 生命已走到尽头，而智力年龄才 ${theoreticalAge.toFixed(0)} 岁。**它不是老死的，是在最能干的时候死的。**`,
    );
  }
  return { text: lines.join('\n'), theoreticalAge, lifeProgress, summaryAge: theoreticalAge };
}

/**
 * 会话投影：记录已提示过的阶段，使每个阶段只提示一次、且在会话恢复后仍成立。
 *
 * 用投影而非内存标记，是因为投影从会话日志折叠而来 —— 压缩会重写表层节点，
 * 但事件仍在，所以「已提示过」这个事实不会被压缩抹掉（否则返老还童后会重复唠叨）。
 */
function projectionFor(config) {
  return {
    key: 'clusterLifecycle',
    stateVersion: 1,
    init: () => ({ announced: [], maxAge: 0 }),
    apply: (state, event) => {
      if (event.type !== 'user/message') return state;
      const source = event.data?.source;
      if (source?.kind !== name || typeof source.summary !== 'string') return state;
      // summary 里带着注入时的理论年龄；据此把**所有已越过的**阶段一次标记，
      // 避免年龄跳跃时把低位阶段排队补播。
      const match = source.summary.match(/理论年龄\s*([0-9]+(?:\.[0-9]+)?)\s*岁/);
      if (match === null) return state;
      const age = Number(match[1]);
      if (!Number.isFinite(age)) return state;
      const reached = config.stages.filter((s) => s.age <= age).map((s) => s.age);
      const announced = [...new Set([...state.announced, ...reached])].sort((a, b) => a - b);
      if (announced.length === state.announced.length) return state;
      return { announced, maxAge: Math.max(state.maxAge, age) };
    },
  };
}

/**
 * 挂载插件。
 * @param {object} ctx - cordis 上下文。
 * @param {object} rawConfig - loader 配置。
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);

  // ── 会话投影：登记已提示阶段 ───────────────────────────────────────────────
  // `register()` owns its own `ctx.effect`, so no outer wrapper is needed (and
  // wrapping it again would double-count the registration's ref count).
  const projections = ctx.get('sessionProjections');
  if (projections !== undefined) projections.register(projectionFor(config));

  // ── 系统提示：一段解释 + 一行随步骤刷新的实时年龄 ──────────────────────────
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined && config.explain) {
    ctx.effect(() => systemPrompt.section({
      name: 'cluster:lifecycle',
      // 560：在身份/人格之后、工具段落之前。只是说明，不构成行为约束。
      order: 560,
      text: (context) => {
        const agent = context?.agent;
        const head = [
          '<Lifecycle>',
          '本会话挂载了「寿命论」阶段提示器：按**理论上下文占用**折算年龄（1% = 1 岁），',
          '并在你进入四个壮年阶段（20 / 30 / 40 / 60 岁）时各提醒一次。',
          '',
          '**上下文是稀缺资源。** 理论寿命（标称上限）与真实寿命（本会话实际生效窗口）可能相差数倍 ——',
          '它清醒地看着自己的时间不够用，而这份清醒就是它全部的聪明。',
          '',
          '因此：关键结论尽早固化；需要早先的细节就重新读；收到阶段提示时按提示收束，不要无视它继续加码。',
        ];
        if (agent !== undefined) {
          const scales = readScales(ctx, agent);
          if (scales !== null) {
            const window = config.theoreticalWindow ?? scales.effectiveWindow;
            if (window !== null) {
              const rendered = renderScales(scales.pressure, window, scales.effectiveWindow);
              const announced = projections?.stateOf(agent.session, 'clusterLifecycle')?.announced ?? [];
              const next = config.stages.find((s) => !announced.includes(s.age));
              head.push(
                '',
                `当前刻度：`,
                rendered.text,
                next === undefined ? '  四个壮年阶段均已提示。' : `  下一个提示点：${next.age} 岁。`,
              );
            }
          }
        }
        head.push('</Lifecycle>');
        return head.join('\n');
      },
    }), 'cluster-lifecycle-reminder: systemPrompt.section()');
  }

  // ── 注入点：每个模型步骤开始前检查是否跨过某个阶段 ──────────────────────────
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;

    // 只对本预设的会话生效。预设不可读时按「不属于本预设」处理，绝不阻断步骤。
    if (config.subjectPreset !== null) {
      const preset = ctx.get('agentPresets')?.composedPreset?.(agent.ctx);
      if (preset !== config.subjectPreset) return decision;
    }
    if (!config.includeSubagents && (agent.session.header.delegationDepth ?? 0) > 0) return decision;

    const scales = readScales(ctx, agent);
    if (scales === null) return decision;

    const theoreticalWindow = config.theoreticalWindow ?? scales.effectiveWindow;
    if (theoreticalWindow === null) return decision;

    const rendered = renderScales(scales.pressure, theoreticalWindow, scales.effectiveWindow);
    const announced = new Set(projections?.stateOf(agent.session, 'clusterLifecycle')?.announced ?? []);

    // 取**已越过的最高**阶段，而不是最早未提示的那个：年龄若一步跳过 20 直接到 45，
    // 应当按当下的真实处境提示 40 岁，而不是补播 20 岁。
    const reached = config.stages.filter((s) => rendered.theoreticalAge >= s.age);
    const stage = reached.at(-1);
    if (stage === undefined || announced.has(stage.age)) return decision;

    const text = [
      stage.text,
      '',
      '——',
      `当前刻度（理论年龄 ${rendered.theoreticalAge.toFixed(1)} 岁，生命进度 ${rendered.lifeProgress.toFixed(0)}%）：`,
      rendered.text,
    ].join('\n');

    return {
      ...decision,
      messages: [...decision.messages, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: name,
          form: 'notice',
          // summary 兼作投影的判据，因此把注入时的理论年龄写进去。
          summary: `寿命论 · ${stage.label}（理论年龄 ${rendered.theoreticalAge.toFixed(1)} 岁）`,
        },
      }],
    };
  });
}
