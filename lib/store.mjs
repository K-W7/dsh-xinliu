// ============================================================================
// 心流 · 状态层
//
// 一条心流 = 一个目录（~/.dsh/xinliu/flows/<id>/）：
//   flow.json      唯一数据源（框架文档由它渲染，手改会被覆盖）
//   当前框架.md    锁版时渲染
//   决策日志.md    只追加
// 另有一个指针文件 ~/.dsh/xinliu/current.json 记录"正在进行的那一条"。
//
// 同时只开一条心流（框架 v1.0 §11-1）：current 指针只指一条，但历史目录都留着。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SECTIONS, emptySections, normalizeSection, pickRoles, sectionTitle } from './template.mjs'
import { renderFramework, renderLogLine } from './render.mjs'

export const ROOT = process.env.DSH_XINLIU_DIR || path.join(os.homedir(), '.dsh', 'xinliu')
export const FLOWS_DIR = path.join(ROOT, 'flows')
export const CURRENT_FILE = path.join(ROOT, 'current.json')
export const FRAMEWORK_FILE = '当前框架.md'
export const LOG_FILE = '决策日志.md'

/** 停滞阈值：3 天没动静就提醒一次（框架 §11-6）。 */
export const STALL_DAYS = 3
const DAY = 86_400_000

const LOG_HEADER = [
  '# 决策日志',
  '',
  '> 只追加，不改写。一行一条：时间 · 类型 · 内容 · 理由。',
  '> 这里回答「当初为什么这么定」——框架正文不存历史版本，历史在这里。',
  '',
].join('\n')

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeAtomic(file, text) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2))
}

export function makeId(title, now = Date.now()) {
  const base = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  const stamp = new Date(now).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `${stamp}-${(base || 'flow').slice(0, 40)}`
}

export function flowDir(id) {
  return path.join(FLOWS_DIR, id)
}

export function flowFile(id) {
  return path.join(flowDir(id), 'flow.json')
}

export function frameworkFile(id) {
  return path.join(flowDir(id), FRAMEWORK_FILE)
}

export function logFile(id) {
  return path.join(flowDir(id), LOG_FILE)
}

function normalizeFlow(raw, id) {
  if (!raw || typeof raw !== 'object') return null
  const base = emptySections()
  const sections = { ...base }
  if (raw.sections && typeof raw.sections === 'object') {
    for (const s of SECTIONS) {
      const got = raw.sections[s.key]
      if (got && typeof got === 'object') {
        sections[s.key] = { ...base[s.key], ...got, key: s.key, title: s.title }
      }
    }
  }
  return {
    version: 1,
    id: raw.id || id,
    title: raw.title || '(未命名)',
    idea: raw.idea || '',
    status: ['drafting', 'locked', 'dropped'].includes(raw.status) ? raw.status : 'drafting',
    createdAt: raw.createdAt || null,
    lockedAt: raw.lockedAt || null,
    lastActivityAt: raw.lastActivityAt || raw.createdAt || null,
    roles: Array.isArray(raw.roles) && raw.roles.length ? raw.roles : ['红队'],
    sections,
    open: Array.isArray(raw.open) ? raw.open : [],
    obstacles: Array.isArray(raw.obstacles) ? raw.obstacles : [],
    log: Array.isArray(raw.log) ? raw.log : [],
  }
}

export function loadFlow(id) {
  if (!id) return null
  return normalizeFlow(readJson(flowFile(id), null), id)
}

export function listFlows() {
  let names = []
  try {
    names = fs.readdirSync(FLOWS_DIR)
  } catch {
    return []
  }
  return names
    .filter((name) => fs.existsSync(flowFile(name)))
    .map((name) => loadFlow(name))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

export function currentId() {
  const data = readJson(CURRENT_FILE, null)
  return data && data.id ? data.id : null
}

export function setCurrent(id) {
  writeJson(CURRENT_FILE, { id, at: Date.now() })
}

export function currentFlow() {
  const id = currentId()
  if (!id) return null
  const flow = loadFlow(id)
  return flow && flow.status === 'drafting' ? flow : null
}

export function createFlow({ title, idea = '', now = Date.now() } = {}) {
  const running = currentFlow()
  if (running) {
    return { ok: false, error: `已经有一条心流在进行了：${running.title}（同时只能开一条）。先 /flow status 看看，或 /flow drop 放下它。`, flow: running }
  }
  const id = makeId(title, now)
  const flow = normalizeFlow(
    {
      id,
      title: String(title || '').trim() || '(未命名)',
      idea: String(idea || '').trim(),
      status: 'drafting',
      createdAt: now,
      lastActivityAt: now,
      roles: pickRoles(title, idea),
      sections: emptySections(),
    },
    id,
  )
  ensureDir(flowDir(id))
  writeJson(flowFile(id), flow)
  writeAtomic(logFile(id), `${LOG_HEADER}\n`)
  setCurrent(id)
  appendLog(flow, { type: '开流', text: `「${flow.title}」开工，角色：${flow.roles.join(' / ')}`, now })
  saveFlow(flow)
  return { ok: true, flow }
}

/** 把一条记录追加进决策日志（只追加，永不改写）。 */
export function appendLog(flow, { type, text, reason = '', now = Date.now() } = {}) {
  const entry = { at: now, type, text, reason }
  flow.log.push(entry)
  if (flow.log.length > 500) flow.log = flow.log.slice(-500)
  try {
    ensureDir(flowDir(flow.id))
    fs.appendFileSync(logFile(flow.id), `${renderLogLine(entry)}\n`)
  } catch {
    /* 日志写不了不影响主流程 */
  }
  return entry
}

export function saveFlow(flow) {
  writeJson(flowFile(flow.id), flow)
}

export function settle(flow, { section, conclusion, reason = '', taste = '', now = Date.now() } = {}) {
  if (flow.status === 'locked') return { ok: false, error: '这条心流已锁版；要改走回补（/flow reopen）' }
  const key = normalizeSection(section)
  if (!key) return { ok: false, error: `认不出章节「${section}」。可用：${SECTIONS.map((s) => s.key).join(' / ')}` }
  const text = String(conclusion || '').trim()
  if (!text) return { ok: false, error: '结论不能为空' }
  const s = flow.sections[key]
  s.settled = true
  s.conclusion = text
  s.reason = String(reason || '').trim()
  s.taste = String(taste || '').trim()
  s.updatedAt = now
  flow.lastActivityAt = now
  appendLog(flow, { type: '已定', text: `「${sectionTitle(key)}」：${text}`, reason, now })
  saveFlow(flow)
  return { ok: true, section: key, title: sectionTitle(key), missingTaste: !s.taste }
}

export function unsetSettled(flow, { section, now = Date.now() } = {}) {
  const key = normalizeSection(section)
  if (!key) return { ok: false, error: `认不出章节「${section}」` }
  const s = flow.sections[key]
  s.settled = false
  s.updatedAt = now
  flow.lastActivityAt = now
  appendLog(flow, { type: '翻回待定', text: `「${sectionTitle(key)}」重新打开`, now })
  saveFlow(flow)
  return { ok: true, section: key }
}

export function deferQuestion(flow, { question = '', resolveId = '', now = Date.now() } = {}) {
  if (resolveId) {
    const before = flow.open.length
    flow.open = flow.open.filter((q) => q.id !== resolveId)
    flow.lastActivityAt = now
    saveFlow(flow)
    return { ok: true, resolved: before !== flow.open.length, id: resolveId }
  }
  const text = String(question || '').trim()
  if (!text) return { ok: false, error: '待定问题不能为空' }
  const item = { id: `q${flow.open.length + 1}`, question: text, at: now }
  flow.open.push(item)
  flow.lastActivityAt = now
  appendLog(flow, { type: '待定', text, now })
  saveFlow(flow)
  return { ok: true, item }
}

export function recordObstacle(flow, { id = '', text = '', impact = '', owner = '', status = '', now = Date.now() } = {}) {
  if (id) {
    const found = flow.obstacles.find((o) => o.id === id)
    if (!found) return { ok: false, error: `没有编号为 ${id} 的障碍` }
    if (owner) found.owner = String(owner)
    if (status) {
      if (!['open', 'owned', 'closed'].includes(status)) return { ok: false, error: 'status 只能是 open / owned / closed' }
      found.status = status
    }
    found.updatedAt = now
    flow.lastActivityAt = now
    appendLog(flow, { type: '障碍更新', text: `[${id}] ${found.text} → ${found.status}${found.owner ? `（${found.owner}）` : ''}`, now })
    saveFlow(flow)
    return { ok: true, obstacle: found }
  }
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: '障碍内容不能为空' }
  const item = {
    id: `o${flow.obstacles.length + 1}`,
    text: body,
    impact: String(impact || '').trim(),
    owner: String(owner || '').trim(),
    status: 'open',
    createdAt: now,
  }
  flow.obstacles.push(item)
  flow.lastActivityAt = now
  appendLog(flow, { type: '障碍', text: body, reason: item.impact, now })
  saveFlow(flow)
  return { ok: true, obstacle: item }
}

/** 锁版前置校验：7 节齐全 + 每节有对味判据 + 无障碍未认领（框架 §11-4/5）。 */
export function lockCheck(flow) {
  const missing = []
  for (const s of SECTIONS) {
    const got = flow.sections[s.key]
    if (!got || !got.settled) missing.push(`缺章节：${s.title}`)
    else if (!got.taste) missing.push(`「${s.title}」缺「怎样算对味」`)
  }
  for (const o of flow.obstacles) {
    if (o.status === 'open') missing.push(`障碍未认领：${o.text}`)
  }
  return { ok: missing.length === 0, missing, openQuestions: flow.open.length }
}

export function lockFlow(flow, { now = Date.now() } = {}) {
  if (flow.status === 'locked') return { ok: false, error: '已经锁版了' }
  const check = lockCheck(flow)
  if (!check.ok) return { ok: false, error: '还不能锁版', missing: check.missing, openQuestions: check.openQuestions }
  flow.status = 'locked'
  flow.lockedAt = now
  flow.lastActivityAt = now
  appendLog(flow, { type: '锁版', text: `「${flow.title}」锁版`, now })
  saveFlow(flow)
  writeAtomic(frameworkFile(flow.id), renderFramework(flow))
  if (currentId() === flow.id) {
    try {
      fs.unlinkSync(CURRENT_FILE)
    } catch {
      /* 指针没了也无所谓 */
    }
  }
  return { ok: true, flow, file: frameworkFile(flow.id) }
}

/** 锁版后要改：重新打开（走回补，不重开框架）。 */
export function reopenFlow(flow, { reason = '', now = Date.now() } = {}) {
  if (flow.status !== 'locked') return { ok: false, error: '这条还没锁版' }
  flow.status = 'drafting'
  flow.lockedAt = null
  flow.lastActivityAt = now
  appendLog(flow, { type: '重新打开', text: `「${flow.title}」回补`, reason, now })
  saveFlow(flow)
  setCurrent(flow.id)
  return { ok: true, flow }
}

export function dropFlow(flow, { now = Date.now() } = {}) {
  flow.status = 'dropped'
  flow.lastActivityAt = now
  appendLog(flow, { type: '放下', text: `「${flow.title}」先放下`, now })
  saveFlow(flow)
  if (currentId() === flow.id) {
    try {
      fs.unlinkSync(CURRENT_FILE)
    } catch {
      /* ignore */
    }
  }
  return { ok: true }
}

export function statusOf(flow, now = Date.now()) {
  const settled = SECTIONS.filter((s) => flow.sections[s.key] && flow.sections[s.key].settled).length
  const withTaste = SECTIONS.filter((s) => flow.sections[s.key] && flow.sections[s.key].settled && flow.sections[s.key].taste).length
  const openObstacles = flow.obstacles.filter((o) => o.status === 'open')
  const idleMs = now - (flow.lastActivityAt || now)
  return {
    ok: true,
    id: flow.id,
    title: flow.title,
    status: flow.status,
    settled,
    total: SECTIONS.length,
    withTaste,
    openQuestions: flow.open.map((q) => ({ id: q.id, question: q.question })),
    obstacles: flow.obstacles.map((o) => ({ id: o.id, text: o.text, status: o.status, owner: o.owner })),
    openObstacles: openObstacles.length,
    stalled: flow.status === 'drafting' && idleMs >= STALL_DAYS * DAY,
    idleDays: Math.floor(idleMs / DAY),
    lockable: lockCheck(flow).ok,
    missing: lockCheck(flow).missing,
  }
}
