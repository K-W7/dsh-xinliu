// ============================================================================
// 心流（dsh-xinliu）· host 半区 · M1
//
// 做三件事：
//   1. 提示词：常驻一句"听出想法就问"，敲定中注入当前进度与规矩（短句、给选项、红队在场）
//   2. 六个工具：开流 / 敲定一节 / 记待定 / 记障碍 / 看进度 / 锁版
//   3. /flow 命令：start / status / lock / reopen / drop / help
//
// 契约依据（DSH 0.2.x，取自本机 dsh-memory-layer@0.11.1 / dsh-fuse@2.0.6 源码）：
//   export const inject = ['systemPrompt']
//   ctx.systemPrompt.context({ name, order, text: () => string })   // 每轮重新求值，返回空串=不占 token
//   ctx.tools.register({ name, description, parameters, output:{schema, render}, presentCall, execute })
//   ctx.inject(['commands'], c => c.commands.register({ name, description, handler(invocation) }))
//   apply 内不抛穿：注册失败 logger.error 后 return
// ============================================================================

import {
  currentFlow,
  createFlow,
  dropFlow,
  listFlows,
  lockFlow,
  recordObstacle,
  reopenFlow,
  statusOf,
  deferQuestion,
  settle,
} from './lib/store.mjs'
import { SECTION_KEYS } from './lib/template.mjs'

export const inject = ['tools', 'systemPrompt']

const NAME = 'dsh-xinliu'

const PROPOSE_RULE = [
  '[心流] 用户抛出新的项目/作品想法时，问一句「要不要把这件事开成一条心流？」——只问一次，他点头才用 flow_open 开；平时不要推销。',
].join('\n')

function shortList(items, max = 3) {
  return items.slice(0, max).join('；')
}

function activeSectionText() {
  const flow = currentFlow()
  if (!flow) return ''
  const s = statusOf(flow)
  const lines = []
  lines.push(`[心流] 正在敲定「${flow.title}」：已定 ${s.settled}/${s.total}，待定 ${s.openQuestions.length}，障碍 ${s.openObstacles}。`)
  const missing = s.missing.slice(0, 3)
  if (missing.length) lines.push(`还差：${missing.join('；')}`)
  if (s.openQuestions.length) lines.push(`挂着的待定：${shortList(s.openQuestions.map((q) => q.question), 2)}`)
  if (s.openObstacles) lines.push(`未认领的障碍：${shortList(s.obstacles.filter((o) => o.status === 'open').map((o) => o.text), 2)}`)
  if (s.stalled) lines.push(`这条已经停了 ${s.idleDays} 天：先问一句「卡在哪」，别继续问细节。`)
  lines.push('规矩：每轮最多 3 个具体问题且给选项；红队每轮至少一条反对或明确认输；短句、直给、不奉承、不写小作文。')
  return lines.join('\n')
}

function statusText(s) {
  const head = `「${s.title}」${s.status === 'locked' ? '已锁版' : '草案'} · 已定 ${s.settled}/${s.total}（带对味判据 ${s.withTaste}）`
  const bits = [head]
  bits.push(`待定 ${s.openQuestions.length} · 障碍未认领 ${s.openObstacles}`)
  if (s.missing.length) bits.push(`差：${shortList(s.missing, 4)}`)
  if (s.stalled) bits.push(`停了 ${s.idleDays} 天——卡在哪？`)
  if (s.lockable) bits.push('可以锁版了（锁版由你亲手点）。')
  return bits.join('\n')
}

const outputCommon = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    section: { type: 'string' },
    file: { type: 'string' },
    flow: { type: 'object', additionalProperties: true },
    obstacle: { type: 'object', additionalProperties: true },
    item: { type: 'object', additionalProperties: true },
  },
  required: ['ok'],
}

function text(value) {
  return [{ type: 'text', text: value }]
}

function noFlowText() {
  return '现在没有进行中的心流。先 flow_open 开一条。'
}

const TOOLS = [
  {
    name: 'flow_open',
    description: [
      '开一条「心流」：把用户的想法立成一条可敲定的线。同一时间只能有一条。',
      'title 必填（一句话能叫出名）；idea 是他刚才那句原话，尽量保留，别改写。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '这条心流的名字，一句话' },
        idea: { type: 'string', description: '用户的原话/想法，尽量原样' },
      },
      required: ['title'],
    },
    output: { schema: outputCommon, render: (_a, v) => text(v.ok ? `开流：「${v.flow.title}」｜角色：${v.flow.roles.join(' / ')}\n7 节还都是空的，从「一句话定位」开始。` : v.error || '开流失败') },
    presentCall: (args) => ({ card: 'generic', title: '开一条心流', kind: 'other', rawInput: args }),
    async execute(args) {
      const r = createFlow({ title: (args && args.title) || '', idea: (args && args.idea) || '' })
      if (!r.ok) return r
      return { ok: true, flow: { id: r.flow.id, title: r.flow.title, roles: r.flow.roles } }
    },
  },
  {
    name: 'flow_settle',
    description: [
      '敲定一节：落「结论 + 为什么 + 怎样算对味」。section 用 key（positioning/audience/features/interaction/data/risks/milestones）或中文名。',
      'taste 别省：没有「怎样算对味」这一节不算完成，锁版会被拒绝。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: SECTION_KEYS.join(' / ') },
        conclusion: { type: 'string', description: '这一节最终定了什么' },
        reason: { type: 'string', description: '为什么这么定' },
        taste: { type: 'string', description: '怎样算对味——可检验的一句话' },
      },
      required: ['section', 'conclusion'],
    },
    output: {
      schema: outputCommon,
      render: (_a, v) => text(v.ok ? `已定「${v.title}」${v.missingTaste ? '\n注意：还缺「怎样算对味」，锁版前补上。' : ''}` : v.error || '敲定失败'),
    },
    presentCall: (args) => ({ card: 'generic', title: '敲定一节', kind: 'other', rawInput: args }),
    async execute(args) {
      const flow = currentFlow()
      if (!flow) return { ok: false, error: noFlowText() }
      const r = settle(flow, {
        section: (args && args.section) || '',
        conclusion: (args && args.conclusion) || '',
        reason: (args && args.reason) || '',
        taste: (args && args.taste) || '',
      })
      return r
    },
  },
  {
    name: 'flow_defer',
    description: '记一条待定（还没结论的），或传 resolveId 把某条待定销掉。待定不是障碍，别混。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '待定的问题' },
        resolveId: { type: 'string', description: '要销掉的待定编号，如 q1' },
      },
    },
    output: {
      schema: outputCommon,
      render: (_a, v) => {
        if (!v || v.ok === false) return text((v && v.error) || '记录失败')
        if (v.resolved) return text(`已销掉待定 ${v.id}`)
        if (v.item) return text(`记下待定 [${v.item.id}]：${v.item.question}`)
        return text(`没找到待定 ${v.id || ''}`)
      },
    },
    presentCall: (args) => ({ card: 'generic', title: '记待定', kind: 'other', rawInput: args }),
    async execute(args) {
      const flow = currentFlow()
      if (!flow) return { ok: false, error: noFlowText() }
      return deferQuestion(flow, {
        question: (args && args.question) || '',
        resolveId: (args && args.resolveId) || '',
      })
    },
  },
  {
    name: 'flow_obstacle',
    description: [
      '记一条障碍（已发现、还没解决的坑），或更新已有障碍：传 id + status(open/owned/closed) + owner。',
      '锁版前所有障碍必须不是 open。发现卡住了就记，别让坑溜成"以后再想"。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '障碍是什么' },
        impact: { type: 'string', description: '影响什么' },
        owner: { type: 'string', description: '谁认领' },
        id: { type: 'string', description: '要更新的障碍编号，如 o1' },
        status: { type: 'string', enum: ['open', 'owned', 'closed'], description: '更新状态' },
      },
    },
    output: {
      schema: outputCommon,
      render: (_a, v) => text(v.ok ? `障碍 [${v.obstacle.id}] ${v.obstacle.text} → ${v.obstacle.status}${v.obstacle.owner ? `（${v.obstacle.owner}）` : ''}` : v.error || '记录失败'),
    },
    presentCall: (args) => ({ card: 'generic', title: '记障碍', kind: 'other', rawInput: args }),
    async execute(args) {
      const flow = currentFlow()
      if (!flow) return { ok: false, error: noFlowText() }
      return recordObstacle(flow, {
        id: (args && args.id) || '',
        text: (args && args.text) || '',
        impact: (args && args.impact) || '',
        owner: (args && args.owner) || '',
        status: (args && args.status) || '',
      })
    },
  },
  {
    name: 'flow_status',
    description: '看当前心流进度：已定几节、待定几条、障碍几条、能不能锁版。只读。',
    parameters: { type: 'object', properties: {} },
    output: { schema: outputCommon, render: (_a, v) => text(v.ok ? statusText(v) : v.error || '读取失败') },
    presentCall: (args) => ({ card: 'generic', title: '心流进度', kind: 'other', rawInput: args }),
    async execute() {
      const flow = currentFlow()
      if (!flow) return { ok: false, error: noFlowText() }
      return statusOf(flow)
    },
  },
  {
    name: 'flow_lock',
    description: '锁版：把 7 节渲染成《当前框架.md》。条件不满足会拒绝并列出还差什么。锁不锁由用户点，不要替他决定。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: outputCommon,
      render: (_a, v) => text(v.ok ? `已锁版。框架写到：${v.file}` : `${v.error || '锁版失败'}${v.missing && v.missing.length ? `\n还差：\n- ${v.missing.join('\n- ')}` : ''}`),
    },
    presentCall: (args) => ({ card: 'generic', title: '锁版', kind: 'other', rawInput: args }),
    async execute() {
      const flow = currentFlow()
      if (!flow) return { ok: false, error: noFlowText() }
      const r = lockFlow(flow)
      if (!r.ok) return r
      return { ok: true, file: r.file }
    },
  },
]

function latestLockedFlow() {
  return listFlows().find((f) => f.status === 'locked') || null
}

function registerCommand(ctx) {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'flow',
      description: '心流：start <名字> / status / lock / reopen / drop / help',
      handler(invocation) {
        const tokens = ((invocation && invocation.rawInput) || '').trim().split(/\s+/).filter(Boolean)
        const verb = (tokens[0] || 'status').toLowerCase()
        const rest = tokens.slice(1).join(' ').trim()

        if (verb === 'start') {
          if (!rest) return { kind: 'success', text: '用法：/flow start <这条心流的名字>' }
          const r = createFlow({ title: rest })
          if (!r.ok) return { kind: 'success', text: r.error }
          return { kind: 'success', text: `开流：「${r.flow.title}」｜角色：${r.flow.roles.join(' / ')}\n先从「一句话定位」开始。` }
        }

        if (verb === 'lock') {
          const flow = currentFlow()
          if (!flow) return { kind: 'success', text: '没有进行中的心流可锁。' }
          const r = lockFlow(flow)
          if (!r.ok) return { kind: 'success', text: `还不能锁版：\n- ${(r.missing || []).join('\n- ')}` }
          return { kind: 'success', text: `已锁版：${r.file}` }
        }

        if (verb === 'reopen') {
          const flow = latestLockedFlow()
          if (!flow) return { kind: 'success', text: '没有已锁版的心流。' }
          const r = reopenFlow(flow, { reason: rest })
          if (!r.ok) return { kind: 'success', text: r.error }
          return { kind: 'success', text: `重新打开「${flow.title}」，改完再锁一次。` }
        }

        if (verb === 'drop') {
          const flow = currentFlow()
          if (!flow) return { kind: 'success', text: '没有进行中的心流。' }
          dropFlow(flow)
          return { kind: 'success', text: `先放下「${flow.title}」。以后 /flow 不会自动接上它。` }
        }

        if (verb === 'help') {
          return {
            kind: 'success',
            text: [
              '/flow start <名字> —— 开一条心流',
              '/flow status —— 进度（已定/待定/障碍）',
              '/flow lock —— 锁版，产出《当前框架.md》',
              '/flow reopen —— 锁版后要改，重新打开',
              '/flow drop —— 先放下',
              '逐条敲定由对话完成（我会调用工具）。',
            ].join('\n'),
          }
        }

        const flow = currentFlow()
        if (!flow) return { kind: 'success', text: '没有进行中的心流。要开一条就 /flow start <名字>。' }
        return { kind: 'success', text: statusText(statusOf(flow)) }
      },
    })
  })
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger || {}

  // 1. 提示词：常驻一句"听出想法就问"；敲定中再注入进度与规矩
  //    injectPrompt:false 时整段跳过（工具与命令照常可用）
  if (!config || config.injectPrompt !== false) {
    try {
      ctx.systemPrompt.context({ name: 'flow:propose', order: -70, text: () => PROPOSE_RULE })
      ctx.systemPrompt.context({ name: 'flow:active', order: -60, text: () => activeSectionText() })
    } catch (error) {
      logger.warn?.(`[${NAME}] 提示词注入失败，工具仍可用：${error && error.message}`)
    }
  }

  // 2. 工具
  try {
    for (const tool of TOOLS) ctx.tools.register(tool)
  } catch (error) {
    logger.error?.(`[${NAME}] 工具注册失败：${error && error.message}`)
    return
  }

  // 3. 命令（commands 服务缺失时自动跳过）
  try {
    registerCommand(ctx)
  } catch (error) {
    logger.warn?.(`[${NAME}] 命令注册失败，工具仍可用：${error && error.message}`)
  }

  if (config && config.injectPrompt === false) {
    logger.info?.(`[${NAME}] injectPrompt=false：只注册工具与命令`)
  }
  const running = currentFlow()
  logger.info?.(`[${NAME}] v1.0 启动${running ? `：进行中「${running.title}」` : '：当前没有进行中的心流'}`)
}
