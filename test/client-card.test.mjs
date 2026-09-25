// 客户端 bundle 冒烟测试：在模拟的 __ModuleLoader__ / require 环境里加载 client.js，
// 断言它导出了 apply + inject，并且 apply() 正确注册了设置卡片。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(__dirname, '..', 'client', 'client.js')

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok  ', name); pass++ }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++ }
}

// —— 极简 React 替身：卡片测试不需要真正渲染 ——
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (v) => [v, () => {}],
  useCallback: (f) => f,
}

const registrations = []
let loaderTarget = null
globalThis.window = {
  __ModuleLoader__: {
    load(reg) { registrations.push(reg) },
  },
}

const source = readFileSync(bundlePath, 'utf-8')
// 在模拟环境里执行 bundle（它会调用 window.__ModuleLoader__.load）
// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(globalThis.window, (spec) => {
  if (spec === 'react') return ReactStub
  throw new Error('unexpected require: ' + spec)
})

t('bundle 注册了工厂', () => {
  if (registrations.length !== 1) throw new Error('registrations=' + registrations.length)
  if (registrations[0].id !== 'dsh-tingxue') throw new Error('id=' + registrations[0].id)
  if (typeof registrations[0].factory !== 'function') throw new Error('factory 不是函数')
})

// 物化 factory
const requiredSpecs = []
const exports_ = registrations[0].factory((spec) => {
  requiredSpecs.push(spec)
  if (spec === 'react') return ReactStub
  throw new Error('unexpected require: ' + spec)
})

t('导出 apply 函数', () => { if (typeof exports_.apply !== 'function') throw new Error('typeof=' + typeof exports_.apply) })
t('导出 inject 数组', () => {
  if (!Array.isArray(exports_.inject)) throw new Error('not array')
  const need = ['slots', 'locale', 'settingsScope']
  for (const n of need) if (!exports_.inject.includes(n)) throw new Error('missing ' + n)
})
t('只 require 了 react', () => {
  const bad = requiredSpecs.filter((s) => s !== 'react')
  if (bad.length > 0) throw new Error('extra: ' + bad.join(','))
})
t('Object.toStringTag 为 Module', () => {
  if (exports_[Symbol.toStringTag] !== 'Module') throw new Error('tag=' + String(exports_[Symbol.toStringTag]))
})

// —— 模拟客户端 ctx，跑 apply ——
const slotRegistrations = []
const localeRegistrations = []
const scopeBinds = []
const effects = []

const boundScope = {
  getSnapshot: () => ({ status: 'ready', writable: true, value: { recentRounds: 10 }, base: {}, user: {} }),
  subscribe: () => () => {},
  set: async () => {},
  unset: async () => {},
}

const ctx = {
  effect: (fn, label) => { effects.push(label); const d = fn(); return d },
  locale: {
    register: (ns, dict) => { localeRegistrations.push({ ns, dict }); return () => {} },
    bind: (ns) => (key) => {
      const d = localeRegistrations.find((r) => r.ns === ns)
      const zh = d && d.dict && d.dict.zh
      return (zh && zh[key]) || key
    },
  },
  settingsScope: {
    bind: (spec) => { scopeBinds.push(spec); return boundScope },
  },
  slots: {
    inject: (key, cb) => { const r = cb(); return r },
    register: (options, Component) => {
      slotRegistrations.push({ options, Component })
      return () => {}
    },
  },
}

let applyError = null
try { exports_.apply(ctx) } catch (e) { applyError = e }

t('apply 未抛错', () => { if (applyError) throw new Error(applyError.message) })
t('注册了 locale 字典', () => {
  if (localeRegistrations.length !== 1) throw new Error('count=' + localeRegistrations.length)
  if (localeRegistrations[0].ns !== 'settings.tingxue') throw new Error('ns=' + localeRegistrations[0].ns)
  const d = localeRegistrations[0].dict
  if (!d.zh || !d.en) throw new Error('缺 zh/en')
  // t2 B：标题统一成「听雪」，「双模式虚拟生命系统」降为独立说明行。
  if (d.zh.title !== '听雪') throw new Error('zh.title=' + d.zh.title)
  if (d.zh.subtitle !== '双模式虚拟生命系统') throw new Error('zh.subtitle=' + d.zh.subtitle)
  if (d.zh.nav !== '听雪') throw new Error('zh.nav=' + d.zh.nav)
  if (d.en.title !== 'Tingxue') throw new Error('en.title=' + d.en.title)
  if (!d.en.subtitle) throw new Error('缺 en.subtitle')
})
// t2 C：搜索框必须自带底色。旧代码用 S.input（background:transparent）叠在深色弹窗上，
// 浅色主题下实测对比度只有 1.04:1（深底 + 深字）。这里守住「不再是 transparent」。
t('模型选择弹窗的搜索框自带不透明底色', () => {
  const src = source
  const m = /inputOnDark:\s*\{([\s\S]*?)\}/.exec(src)
  if (!m) throw new Error('找不到 inputOnDark 样式')
  const body = m[1]
  if (!/background:\s*'#ffffff'/.test(body)) throw new Error('搜索框底色不是纯白: ' + body)
  if (!/color:\s*'#1b1b1f'/.test(body)) throw new Error('搜索框文字色没固定: ' + body)
  if (/background:\s*'transparent'/.test(body)) throw new Error('搜索框底色仍是 transparent')
  if (!/style:\s*S\.inputOnDark/.test(src)) throw new Error('搜索框没有用 S.inputOnDark')
})
// 同一处教训：弹窗自带固定深底，所以前景也必须固定，不能 color:inherit。
t('模型选择弹窗固定前景色（不再 color:inherit）', () => {
  // 注意 var(--dsh-fg, #e8e8ea) 里也有花括号内的逗号 → 用 \}(?=\s*,) 收尾，别越界到下一个样式。
  const m = /modal:\s*\{([\s\S]*?)\}(?=\s*,)/.exec(source)
  if (!m) throw new Error('找不到 modal 样式')
  // 先去注释：注释里会写「不能 color:inherit」，那不是样式声明。
  const body = m[1].replace(/\/\/[^\n]*/g, '')
  if (/color:\s*'inherit'/.test(body)) throw new Error('弹窗仍在使用 color:inherit')
  if (!/color:\s*'var\(--dsh-fg/.test(body)) throw new Error('弹窗前景没有固定: ' + body)
})
t('bind 了正确的命名空间', () => {
  if (scopeBinds.length !== 1) throw new Error('count=' + scopeBinds.length)
  if (scopeBinds[0].namespace !== 'dsh-tingxue') throw new Error('ns=' + scopeBinds[0].namespace)
})
t('注册进 settings.section（侧边栏独立项）', () => {
  const sec = slotRegistrations.find((r) => r.options.name === 'settings.section')
  if (!sec) throw new Error('没有注册 settings.section')
  const o = sec.options
  if (o.id !== 'tingxue') throw new Error('id=' + o.id)
  if (typeof o.order !== 'number') throw new Error('order 缺失')
  if (typeof o.label !== 'function') throw new Error('label 不是函数')
  if (o.locale !== 'settings.tingxue') throw new Error('locale=' + o.locale)
  if (typeof o.inject !== 'function') throw new Error('inject 不是函数')
  if (typeof sec.Component !== 'function') throw new Error('Component 不是函数')
})
t('侧边栏 label 解析出「听雪」', () => {
  const sec = slotRegistrations.find((r) => r.options.name === 'settings.section')
  const label = sec.options.label()
  if (label !== '听雪') throw new Error('label=' + String(label))
})
// t2 拍板方案 A：只保留侧边栏入口。插件配置标签页里那张「同一个组件、同一份设置」
// 的重复卡片必须不复存在 —— 这条用例在旧代码上会失败（旧代码注册了 plugin.item）。
t('不再注册 settings.plugin.item（重复入口已移除）', () => {
  const extra = slotRegistrations.filter((r) => r.options.name !== 'settings.section')
  if (extra.length > 0) throw new Error('多出来的入口: ' + extra.map((r) => r.options.name).join(','))
})
t('只注册了一个槽位', () => {
  if (slotRegistrations.length !== 1) throw new Error('count=' + slotRegistrations.length)
})

// —— 检查 inject() 面的形状 ——
const face = slotRegistrations.find((r) => r.options.name === 'settings.section').options.inject()
t('inject() 返回 hooks 隔间', () => {
  if (!face || typeof face !== 'object') throw new Error('not object')
  if (!face.hooks || typeof face.hooks !== 'object') throw new Error('no hooks')
  const store = face.hooks.card
  if (!store || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') {
    throw new Error('card store 不是 HostObservable')
  }
})
t('inject() 暴露动作', () => {
  for (const k of ['save', 'discard', 'edit', 'resetField']) {
    if (typeof face[k] !== 'function') throw new Error('missing action ' + k)
  }
})
t('store 快照含全部字段', () => {
  const snap = face.hooks.card.getSnapshot()
  if (!Array.isArray(snap.fields) || snap.fields.length < 20) throw new Error('fields=' + (snap.fields && snap.fields.length))
  if (snap.writable !== true) throw new Error('writable=' + snap.writable)
})

// —— 暂存/保存行为 ——
t('edit 后 dirty=true 且草稿生效', () => {
  face.edit('recentRounds', '42')
  const snap = face.hooks.card.getSnapshot()
  if (snap.dirty !== true) throw new Error('dirty=' + snap.dirty)
  const f = snap.fields.find((x) => x.key === 'recentRounds')
  if (f.draft !== '42') throw new Error('draft=' + f.draft)
})
t('非法数字被标记 invalid', () => {
  face.edit('recentRounds', 'abc')
  const snap = face.hooks.card.getSnapshot()
  const f = snap.fields.find((x) => x.key === 'recentRounds')
  if (f.invalid !== true) throw new Error('invalid=' + f.invalid)
})
t('discard 清掉草稿', () => {
  face.discard()
  const snap = face.hooks.card.getSnapshot()
  if (snap.dirty !== false) throw new Error('dirty=' + snap.dirty)
})

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
