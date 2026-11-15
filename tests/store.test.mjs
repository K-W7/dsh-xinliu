// 心流 · 状态层单测（node --test tests/）
// 只测纯逻辑与文件落盘，不依赖 DSH 宿主，装插件之前就能跑。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-xinliu-'))
process.env.DSH_XINLIU_DIR = DIR

const store = await import('../lib/store.mjs')
const { renderFramework, renderLogLine, formatTime } = await import('../lib/render.mjs')
const { SECTION_KEYS } = await import('../lib/template.mjs')

test('开一条心流：7 节全空，角色含红队', () => {
  const r = store.createFlow({ title: '做个东西', idea: '想让 AI 记住为什么这么定' })
  assert.equal(r.ok, true)
  assert.equal(r.flow.status, 'drafting')
  assert.equal(r.flow.roles.includes('红队'), true)
  for (const key of SECTION_KEYS) assert.equal(r.flow.sections[key].settled, false)
  assert.equal(store.currentFlow().id, r.flow.id)
})

test('同时只能开一条', () => {
  const again = store.createFlow({ title: '第二个' })
  assert.equal(again.ok, false)
  assert.match(again.error, /只能开一条/)
})

test('敲定：认得出中文章节名，缺结论要拒绝', () => {
  const flow = store.currentFlow()
  const bad = store.settle(flow, { section: '定位', conclusion: '   ' })
  assert.equal(bad.ok, false)
  const wrong = store.settle(flow, { section: '瞎写的', conclusion: 'x' })
  assert.equal(wrong.ok, false)
  const ok = store.settle(flow, { section: '定位', conclusion: '一个能开工的框架', reason: '先定方向', taste: '能拿它直接开工' })
  assert.equal(ok.ok, true)
  assert.equal(ok.section, 'positioning')
  assert.equal(ok.missingTaste, false)
})

test('锁版前置：缺章节要列出来', () => {
  const flow = store.currentFlow()
  const check = store.lockCheck(flow)
  assert.equal(check.ok, false)
  assert.equal(check.missing.length, 6)
  assert.equal(check.missing[0].includes('一句话定位'), false)
})

test('锁版前置：有未认领障碍时拒绝', () => {
  const flow = store.currentFlow()
  const r = store.recordObstacle(flow, { text: '还没想好怎么存数据', impact: '锁版前必须定' })
  assert.equal(r.ok, true)
  assert.equal(r.obstacle.status, 'open')
  const check = store.lockCheck(store.currentFlow())
  assert.equal(check.ok, false)
  assert.equal(check.missing.some((m) => m.includes('障碍未认领')), true)
  // 认领后不再是阻塞项（但其他 6 节还空着）
  store.recordObstacle(store.currentFlow(), { id: r.obstacle.id, status: 'owned', owner: '技术' })
  assert.equal(store.lockCheck(store.currentFlow()).missing.some((m) => m.includes('障碍')), false)
})

test('待定可记可销', () => {
  const flow = store.currentFlow()
  const a = store.deferQuestion(flow, { question: '锁版后怎么回补？' })
  assert.equal(a.ok, true)
  assert.equal(a.item.id, 'q1')
  const b = store.deferQuestion(store.currentFlow(), { resolveId: 'q1' })
  assert.equal(b.ok, true)
  assert.equal(b.resolved, true)
  assert.equal(store.currentFlow().open.length, 0)
})

test('7 节齐全 + 对味判据 → 锁版成功，写出框架文件', () => {
  const flow = store.currentFlow()
  for (const key of SECTION_KEYS) {
    const r = store.settle(store.currentFlow(), { section: key, conclusion: `${key} 的结论`, reason: '因为要开工', taste: `${key} 能直接开工` })
    assert.equal(r.ok, true, `${key} 应能敲定`)
  }
  const check = store.lockCheck(store.currentFlow())
  assert.equal(check.ok, true)

  const locked = store.lockFlow(store.currentFlow())
  assert.equal(locked.ok, true)
  assert.equal(locked.flow.status, 'locked')
  assert.equal(fs.existsSync(locked.file), true)

  const md = fs.readFileSync(locked.file, 'utf8')
  assert.match(md, /当前框架/)
  assert.match(md, /一句话定位/)
  assert.match(md, /里程碑与验收/)
  assert.equal(store.currentFlow(), null, '锁版后不该再有进行中的心流')
})

test('框架文档标了"手改会被覆盖"', () => {
  const flow = store.listFlows().find((f) => f.status === 'locked')
  const md = renderFramework(flow)
  assert.match(md, /手改会被覆盖/)
})

test('决策日志只追加：开流、已定、障碍、锁版都留痕', () => {
  const flow = store.listFlows().find((f) => f.status === 'locked')
  const log = fs.readFileSync(store.logFile(flow.id), 'utf8')
  assert.match(log, /开流/)
  assert.match(log, /已定/)
  assert.match(log, /障碍/)
  assert.match(log, /锁版/)
})

test('日志行格式：时间 · 类型 · 内容 · 理由', () => {
  const line = renderLogLine({ at: Date.UTC(2026, 9, 30, 10, 0), type: '已定', text: '定位：A', reason: 'B' })
  assert.match(line, /^- 2026-10-30 \d{2}:\d{2} · 已定 · 定位：A · 理由：B$/)
  assert.equal(formatTime(null), '—')
})

test('坏 flow.json 不炸，返回 null', () => {
  fs.mkdirSync(store.flowDir('broken'), { recursive: true })
  fs.writeFileSync(store.flowFile('broken'), '{ 这不是 json')
  assert.equal(store.loadFlow('broken'), null)
})

test('重新打开：锁版后能回补，并重新成为当前', () => {
  const locked = store.listFlows().find((f) => f.status === 'locked')
  const r = store.reopenFlow(locked, { reason: '发现新问题' })
  assert.equal(r.ok, true)
  assert.equal(store.currentId(), locked.id)
  assert.equal(store.currentFlow().id, locked.id)
})
