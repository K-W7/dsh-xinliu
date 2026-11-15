// ============================================================================
// 心流 · 章节模板与角色挑选（纯函数，可单测）
//
// 7 节是锁版的硬条件（框架 v1.0 §6）。少一节就不能锁 —— 不是靠模型自觉，
// 是 lockCheck() 直接拒绝。
// ============================================================================

export const SECTIONS = [
  { key: 'positioning', title: '一句话定位' },
  { key: 'audience', title: '给谁用、什么场景' },
  { key: 'features', title: '功能清单（必须有 / 可以砍 / 不做）' },
  { key: 'interaction', title: '交互与入口' },
  { key: 'data', title: '数据与隐私' },
  { key: 'risks', title: '风险与对策' },
  { key: 'milestones', title: '里程碑与验收' },
]

export const SECTION_KEYS = SECTIONS.map((s) => s.key)

export function sectionTitle(key) {
  const found = SECTIONS.find((s) => s.key === key)
  return found ? found.title : key
}

/** 用户可传中文/英文/序号，统一成 section key；认不出返回 null。 */
export function normalizeSection(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  const exact = SECTIONS.find((s) => s.key === lower || s.title === raw)
  if (exact) return exact.key
  const aliases = [
    ['定位', 'positioning'],
    ['product', 'positioning'],
    ['用户', 'audience'],
    ['受众', 'audience'],
    ['功能', 'features'],
    ['需求', 'features'],
    ['交互', 'interaction'],
    ['入口', 'interaction'],
    ['ui', 'interaction'],
    ['数据', 'data'],
    ['隐私', 'data'],
    ['风险', 'risks'],
    ['里程碑', 'milestones'],
    ['验收', 'milestones'],
  ]
  for (const [needle, key] of aliases) {
    if (raw.includes(needle) || lower.includes(needle)) return key
  }
  return null
}

/**
 * 按项目类型挑角色：不维护固定角色表，红队永远在。
 * 认不出来就给「通用 + 红队」两个，够用就行，不硬凑。
 */
export function pickRoles(title = '', idea = '') {
  const text = `${title} ${idea}`
  const roles = []
  if (/插件|plugin|代码|开发|软件|程序|app|系统|工具|接口|api/i.test(text)) {
    roles.push('产品', '技术实现', '风险安全')
  } else if (/文章|写作|书|小说|文案|内容|课程|演讲/i.test(text)) {
    roles.push('读者', '结构', '表达')
  } else if (/设计|界面|ui|视觉|交互/i.test(text)) {
    roles.push('设计', '技术实现', '用户')
  } else {
    roles.push('通用')
  }
  roles.push('红队')
  return roles
}

/** 新建一条心流时的初始结构。 */
export function emptySections() {
  const sections = {}
  for (const s of SECTIONS) {
    sections[s.key] = {
      key: s.key,
      title: s.title,
      settled: false,
      conclusion: '',
      reason: '',
      taste: '',
      updatedAt: null,
    }
  }
  return sections
}
