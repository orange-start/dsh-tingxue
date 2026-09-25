// Host 半侧冒烟测试：用假 settings 服务验证注册逻辑
import { installTingxueSettings, TINGXUE_SETTINGS_NS, SETTINGS_FIELDS, entrySnapshot, buildSettingsSchema } from '../src/settings/index.mjs'
import z from '@deepseek-ai/schemastery'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok  ', name); pass++ }
  catch (e) { console.log('  FAIL', name, '->', e.message); fail++ }
}

console.log('=== schema ===')
const schema = buildSettingsSchema(z)
t('schema 可构建', () => { if (!schema) throw new Error('empty') })
t('字段数 > 0', () => { if (SETTINGS_FIELDS.length < 10) throw new Error('too few: ' + SETTINGS_FIELDS.length) })

// 用默认值解析一遍，验证 schema 能过
const resolved = schema({})
t('默认值解析成功', () => { if (!resolved) throw new Error('no resolved') })
t('recentRounds 默认 10', () => {
  if (resolved.recentRounds !== 10) throw new Error('got ' + resolved.recentRounds)
})
t('modelBackend 默认 sta1n', () => {
  if (resolved.modelBackend !== 'sta1n') throw new Error('got ' + resolved.modelBackend)
})
t('枚举拒绝非法值', () => {
  let threw = false
  try { schema({ modelBackend: 'bogus' }) } catch { threw = true }
  if (!threw) throw new Error('accepted bogus')
})
t('number 有 min 约束', () => {
  let threw = false
  try { schema({ recentRounds: -5 }) } catch { threw = true }
  if (!threw) throw new Error('accepted -5')
})

console.log('=== entrySnapshot ===')
const cfg = { dataDir: 'D:/x', recentRounds: 30, modelBackend: 'sta1n', unknownKey: 'nope' }
const snap = entrySnapshot(cfg)
t('只取声明过的字段', () => {
  if ('unknownKey' in snap) throw new Error('leaked unknownKey')
})
t('保留已知字段', () => {
  if (snap.dataDir !== 'D:/x' || snap.recentRounds !== 30) throw new Error(JSON.stringify(snap))
})

console.log('=== install（有 settings 服务） ===')
const writes = []
const fakeScope = {
  get: () => ({ recentRounds: 7, dataDir: 'D:/from-settings', modelBackend: 'local' }),
  watch: () => () => {},
}
const fakeSettings = {
  register: (ns, sch, opts) => {
    writes.push({ ns, opts })
    return fakeScope
  },
}
const liveCfg = { recentRounds: 30, dataDir: 'D:/orig', modelBackend: 'sta1n' }
const fakeCtx = {
  get: (n) => (n === 'settings' ? fakeSettings : undefined),
  inject: () => { throw new Error('不该走 inject 兜底') },
}
const ok = await installTingxueSettings(fakeCtx, liveCfg, { warn: (m) => console.log('   [warn]', m) })
t('install 返回 true', () => { if (ok !== true) throw new Error('got ' + ok) })
t('注册了正确命名空间', () => {
  if (writes[0]?.ns !== TINGXUE_SETTINGS_NS) throw new Error('ns=' + writes[0]?.ns)
})
t('applies=restart', () => {
  if (writes[0]?.opts?.applies !== 'restart') throw new Error('applies=' + writes[0]?.opts?.applies)
})
t('base 快照已传入', () => {
  if (writes[0]?.opts?.base?.recentRounds !== 30) throw new Error(JSON.stringify(writes[0]?.opts?.base))
})
t('用户层回写到 config', () => {
  if (liveCfg.recentRounds !== 7 || liveCfg.dataDir !== 'D:/from-settings') throw new Error(JSON.stringify(liveCfg))
})

console.log('=== install（无 settings 服务，优雅降级） ===')
let injected = false
const ctxNoSettings = {
  get: () => undefined,
  inject: (deps, cb) => { injected = true; /* 老宿主：回调永不执行 */ },
}
const cfg2 = { recentRounds: 30 }
const ok2 = await installTingxueSettings(ctxNoSettings, cfg2, { warn: () => {} })
t('返回 false 而非抛错', () => { if (ok2 !== false) throw new Error('got ' + ok2) })
t('尝试了 inject 兜底', () => { if (!injected) throw new Error('no inject') })
t('config 未被破坏', () => { if (cfg2.recentRounds !== 30) throw new Error('mutated') })

console.log('=== install（settings 服务随后挂载，兜底路径生效） ===')
let lateCb = null
const ctxLate = {
  get: () => undefined,
  inject: (deps, cb) => { lateCb = cb },
}
const cfg3 = { recentRounds: 30 }
await installTingxueSettings(ctxLate, cfg3, { warn: () => {} })
t('兜底回调已挂上', () => { if (typeof lateCb !== 'function') throw new Error('no cb') })
lateCb({ settings: fakeSettings })
t('晚挂载后 config 被回写', () => {
  if (cfg3.recentRounds !== 7) throw new Error('got ' + cfg3.recentRounds)
})

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
