// ============================================================================
// 心流 · 渲染层
//
// 框架文档和决策日志都从这里出。原则：flow.json 是唯一数据源，
// 渲染是纯函数（给 flow，出字符串），这样单测不用碰文件系统。
// ============================================================================

import { SECTIONS } from './template.mjs'

function pad(n) {
  return String(n).padStart(2, '0')
}

export function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 决策日志一行。只追加，永不改写。 */
export function renderLogLine(entry) {
  const parts = [`- ${formatTime(entry.at)}`, entry.type]
  if (entry.text) parts.push(entry.text)
  if (entry.reason) parts.push(`理由：${entry.reason}`)
  return parts.join(' · ')
}

function statusLabel(flow) {
  if (flow.status === 'locked') return `已锁版（${formatTime(flow.lockedAt)}）`
  if (flow.status === 'dropped') return '已放下'
  return '草案 · 未锁版'
}

/**
 * 《当前框架.md》全文。
 * 手改会被下次渲染覆盖 —— 所以文件头必须自己声明这件事。
 */
export function renderFramework(flow) {
  const lines = []
  lines.push(`# ${flow.title} · 当前框架`)
  lines.push('')
  lines.push(`> 状态：${statusLabel(flow)} · 由 dsh-xinliu 从 flow.json 渲染，**手改会被覆盖**`)
  lines.push(`> 开流时间：${formatTime(flow.createdAt)} · 角色：${(flow.roles || []).join(' / ')}`)
  if (flow.idea) {
    lines.push('')
    lines.push('## 0. 想法原话')
    lines.push('')
    lines.push(`> ${flow.idea.replace(/\n/g, '\n> ')}`)
  }

  SECTIONS.forEach((s, index) => {
    const got = flow.sections[s.key] || {}
    lines.push('')
    lines.push(`## ${index + 1}. ${s.title}`)
    lines.push('')
    if (got.settled) {
      lines.push(got.conclusion || '（空）')
      if (got.reason) lines.push('', `**为什么这么定**：${got.reason}`)
      if (got.taste) lines.push('', `**怎样算对味**：${got.taste}`)
    } else {
      lines.push('_（还没定）_')
      if (got.conclusion) lines.push('', `目前的想法：${got.conclusion}`)
    }
  })

  if (flow.obstacles && flow.obstacles.length) {
    lines.push('')
    lines.push('## 障碍清单')
    lines.push('')
    const label = { open: '未解决', owned: '有人认领', closed: '已解决' }
    for (const o of flow.obstacles) {
      const who = o.owner ? `（${o.owner}）` : ''
      const why = o.impact ? `：${o.impact}` : ''
      lines.push(`- [${o.id}] ${o.text}${why} —— ${label[o.status] || o.status}${who}`)
    }
  }

  if (flow.open && flow.open.length) {
    lines.push('')
    lines.push('## 待定清单')
    lines.push('')
    for (const q of flow.open) lines.push(`- [${q.id}] ${q.question}`)
  }

  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('决策理由见同目录 `决策日志.md`（只追加）。')
  lines.push('')
  return lines.join('\n')
}
