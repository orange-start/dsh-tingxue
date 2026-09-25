#!/usr/bin/env node
// dsh-tingxue scripts/selfcheck.mjs
//
// 听雪运行状态自检 —— 一条命令看清「重启后有没有退回旧毛病」。
//
// 设计约束：
//  - **零成本**：绝不调用 /memory/search 之类会触发 embedding 的端点（那是要花钱的）。
//    只读本地文件 + 打 /health、/profile 这类纯本地端点。
//  - **只读**：不写记忆库、不改任何配置（用户硬约束）。
//  - **可脚本化**：有问题时 exit 1，全绿 exit 0。
//
// 核心判据（§17.15）：
//   request/header 只在 system 内容**变化时**才落一条新记录。所以
//   「同一轮内出现几条 header」= 该轮 system 变动了几次。
//   同轮应始终 change 0 —— 若某轮 change >= 1 且长度在「带记忆块/不带记忆块」间跳，
//   就是注入又出问题了（记忆块在同一轮里消失）。
//
// 用法：
//   node scripts/selfcheck.mjs              # 人类可读
//   node scripts/selfcheck.mjs --json       # 机器可读
//   node scripts/selfcheck.mjs --full       # 解全部日志帧（默认只解尾部 2000 帧，快）
//   node scripts/selfcheck.mjs --data-dir <path>

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const ARGS = process.argv.slice(2)
const AS_JSON = ARGS.includes('--json')
const FULL = ARGS.includes('--full')
const argVal = (name) => {
  const i = ARGS.indexOf(name)
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : undefined
}

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const MEMORY_PORT = 8766
const DASH_PORT = 8765
const WEB_PORT = 3080

const findings = []   // { level: 'ok'|'warn'|'fail', title, detail }
const ok = (title, detail = '') => findings.push({ level: 'ok', title, detail })
const warn = (title, detail = '') => findings.push({ level: 'warn', title, detail })
const fail = (title, detail = '') => findings.push({ level: 'fail', title, detail })

// ---------- 工具 ----------

/** 在 DSH 会话目录里找某个 sessionId 的日志文件。
 *  注意：state.json 里存的是 `session-<uuid>`（自带 session- 前缀），而目录名就是它本身，
 *  所以要先剥掉前缀再加回去，否则会拼成 `session-session-<uuid>`。 */
function findSessionLog(sessionId) {
  const root = join(DSH_HOME, 'sessions')
  if (!existsSync(root)) return null
  const bare = String(sessionId).replace(/^session-/, '')
  const dirName = `session-${bare}`
  for (const d of readdirSync(root)) {
    const p = join(root, d, dirName, 'session.jsonl.zstd')
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 解 DSH 会话日志（拼接式 zstd 多帧）。
 * @param {string} file
 * @param {number|null} tailFrames - 只解尾部这么多帧；null = 全部
 */
function loadEvents(file, tailFrames = 2000) {
  const raw = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i)
  }
  const from = tailFrames !== null && starts.length > tailFrames ? starts.length - tailFrames : 0
  const truncated = from > 0
  let jsonl = ''
  for (let k = from; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : raw.length
    try { jsonl += zstdDecompressSync(raw.subarray(starts[k], end)).toString('utf8') } catch { /* 半帧，跳过 */ }
  }
  const events = []
  for (const line of jsonl.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { events.push(JSON.parse(t)) } catch { /* 截断的残行 */ }
  }
  return { events, totalFrames: starts.length, fromFrame: from, truncated }
}

/** 按 turn 归位 request/header，统计每个回合的 system 变动次数。 */
function analyzeTurns(events) {
  const MEM = '\u3010\u76f8\u5173\u8bb0\u5fc6\u3011'
  const PROF = '\u3010\u8eab\u4efd\u4e0e\u5916\u89c2\u3011'
  const turns = []
  let cur = null
  for (const e of events) {
    if (e.type === 'turn/start') {
      cur = { turn: e.data?.turn, headers: [], steps: 0, startedAt: e.time }
      turns.push(cur)
    } else if (e.type === 'step/start') {
      if (cur) cur.steps++
    } else if (e.type === 'request/header') {
      if (!cur) continue
      const sys = e.data?.header?.system ?? ''
      cur.headers.push({
        reason: e.data?.reason,
        sysLen: sys.length,
        time: e.time,
        tools: e.data?.header?.tools?.length ?? 0,
        mem: sys.includes(MEM),
        prof: sys.includes(PROF),
      })
    }
  }
  // 首帧可能截断，丢掉第一个不完整的回合
  return turns.filter((t) => t.headers.length > 0)
}

/**
 * 判定一个回合。
 *
 * 关键：**不能用「有 change 记录」当漂移判据**。新回合的第一条 header 天然带
 * reason="change"（相对上一轮的 system 变了，比如新一轮检索出了不同记忆），
 * 那是正常行为。真正的 bug 特征只有一个：
 *   **同一轮内 system 长度出现了多个值** —— 也就是记忆块在轮中途消失
 *   （实测 15817 → 13872，掉的正是记忆块）。
 * 记忆块的有无也一并纳入，双重确认。
 */
function judgeTurn(t) {
  const lens = [...new Set(t.headers.map((h) => h.sysLen))]
  const mems = [...new Set(t.headers.map((h) => h.mem))]
  const changes = t.headers.filter((h) => h.reason === 'change').length
  const drifted = lens.length > 1 || mems.length > 1
  return {
    turn: t.turn,
    steps: t.steps,
    headerCount: t.headers.length,
    changes,
    lens,
    mems,
    sysLen: t.headers[t.headers.length - 1].sysLen,
    firstAt: t.headers[0].time,
    constant: lens.length === 1,
    drifted,
  }
}

/** 找监听某端口的进程启动时间（best-effort，失败返回 null）。 */
function listenerStartTime(port) {
  try {
    const ps = [
      `$c = netstat -ano -p TCP | Select-String ':${port}' | Select-String 'LISTENING' | Select-Object -First 1`,
      'if ($c) {',
      `  $p = ($c.ToString().Trim() -split '\\s+')[-1]`,
      '  try { (Get-Process -Id $p).StartTime.ToString("o") } catch { }',
      '}',
    ].join('; ')
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    }).trim()
    return out ? new Date(out) : null
  } catch {
    return null
  }
}

/** 从 profile 补丁里取配置项（只做简单键匹配，不引入 YAML 依赖）。 */
function readProfileConfig() {
  const p = join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  if (!existsSync(p)) return {}
  const text = readFileSync(p, 'utf8')
  const get = (k) => {
    const m = text.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm'))
    if (!m) return undefined
    return m[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return { dataDir: get('dataDir'), profilePath: get('profilePath'), llmModel: get('llmModel'), embeddingModel: get('embeddingModel'), path: p }
}

/** 定位 dataDir（--data-dir 优先，其次 profile 补丁，最后常见默认）。 */
function resolveDataDir() {
  const explicit = argVal('--data-dir')
  if (explicit) return explicit
  const cfg = readProfileConfig()
  if (cfg.dataDir) return cfg.dataDir
  for (const c of [join(process.cwd(), '.dsh-tingxue-data'), join(process.cwd(), '.dsh-tingxue')]) {
    if (existsSync(join(c, 'state.json'))) return c
  }
  return null
}

// ---------- 各项检查 ----------

async function checkProcessFreshness() {
  const rtDir = join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-tingxue')
  const src = join(rtDir, 'src', 'plugin-entry.mjs')
  const inject = join(rtDir, 'src', 'context', 'inject.mjs')
  const started = listenerStartTime(WEB_PORT)

  if (!existsSync(src)) {
    warn('运行时副本', `没找到 ${src}；无法判断加载的是哪份代码`)
    return { started, newest: null }
  }
  const newest = Math.max(statSync(src).mtimeMs, existsSync(inject) ? statSync(inject).mtimeMs : 0)
  const newestStr = new Date(newest).toISOString()

  if (!started) {
    warn('进程启动时间未知', '拿不到监听 3080 的进程启动时间（netstat/Get-Process 不可用）。请人工确认：DSH 是否在源码改动之后重启')
    return { started: null, newest }
  }

  const fmt = (d) => d.toLocaleString('zh-CN', { hour12: false })
  if (started.getTime() >= newest) {
    ok('运行代码是最新的', `DSH 启动 ${fmt(started)} ≥ 源码改动 ${fmt(new Date(newest))}`)
  } else {
    fail('运行代码是旧的 —— 需要重启 DSH', `DSH 启动 ${fmt(started)} < 源码改动 ${fmt(new Date(newest))}；当前进程加载的是改动前的代码`)
  }
  return { started, newest, newestStr }
}

function checkSlidingWindow(dataDir) {
  if (!dataDir) { warn('滑动窗口', '找不到 dataDir（可用 --data-dir 指定）'); return null }
  const f = join(dataDir, 'state.json')
  if (!existsSync(f)) { warn('滑动窗口', `没有 ${f}`); return null }
  let s
  try { s = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { fail('滑动窗口', `state.json 解析失败：${e.message}`); return null }

  const rr = Array.isArray(s.recentRounds) ? s.recentRounds : []
  let chars = 0
  for (const r of rr) chars += (r.user?.length ?? 0) + (r.assistant?.length ?? 0)
  const latest = Array.isArray(s.latestInfo) ? s.latestInfo.length : 0

  ok('滑动窗口', `${rr.length} 轮 / ${chars} 字符；latestInfo ${latest} 条；mode=${s.mode}`)

  // 上限体检：maxStored 默认 max(recentN*3, 50)
  if (rr.length > 60) warn('滑动窗口轮数偏多', `${rr.length} 轮，超出预期上限 50；检查 maxStoredRounds / recentRounds 配置`)
  if (s.mode === 'agent') {
    warn('mode = agent', `agentSessionId=${s.agentSessionId}；聊天上下文注入在 agent 模式下是关的。若 QQ 并未绑到该隔离会话，应 /agentstop`)
  }
  return s
}

function checkBinding(state, dataDir) {
  const nf = join(DSH_HOME, 'dsh-notifier', 'state.json')
  if (!existsSync(nf)) { warn('QQ 绑定', `没有 ${nf}`); return null }
  let ns
  try { ns = JSON.parse(readFileSync(nf, 'utf8')) } catch (e) { warn('QQ 绑定', `解析失败：${e.message}`); return null }
  const store = ns?.store ?? ns
  const binds = Object.entries(store ?? {}).filter(([k]) => k.startsWith('bind:'))
  if (binds.length === 0) { warn('QQ 绑定', '没有任何 bind: 键'); return null }

  const chat = state?.chatSessionId
  const agent = state?.agentSessionId
  for (const [k, v] of binds) {
    if (agent && v === agent) {
      ok('QQ 绑定', `${k} → 隔离会话（agent 模式生效，与 state 一致）`)
    } else if (chat && v === chat) {
      ok('QQ 绑定', `${k} → 聊天会话（与 state.chatSessionId 一致）`)
    } else {
      warn('QQ 绑定指向未知会话', `${k} → ${String(v).slice(0, 30)}…（state 里 chat/agent 都对不上）`)
    }
  }
  return binds
}

async function checkEndpoints(dataDir) {
  // 记忆服务：只打 /health（纯本地，不触发 embedding）
  try {
    const r = await fetch(`http://127.0.0.1:${MEMORY_PORT}/health`, { signal: AbortSignal.timeout(5000) })
    const j = await r.json().catch(() => null)
    if (r.ok && j?.ok) ok('记忆服务 8766', `ok / service=${j.service}`)
    else fail('记忆服务 8766', `HTTP ${r.status}，body=${JSON.stringify(j)}`)
  } catch (e) {
    fail('记忆服务 8766', `连不上：${e.message}`)
  }

  // /profile 只读人格文件，同样零成本
  try {
    const r = await fetch(`http://127.0.0.1:${MEMORY_PORT}/profile`, { signal: AbortSignal.timeout(8000) })
    const j = await r.json().catch(() => null)
    if (r.ok && j?.ok) ok('人格档案可达', `${String(j.profile ?? '').length} 字符`)
    else warn('人格档案', `HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 120)}`)
  } catch (e) {
    warn('人格档案', `读取失败：${e.message}`)
  }

  // 图谱面板
  try {
    const r = await fetch(`http://127.0.0.1:${DASH_PORT}/`, { signal: AbortSignal.timeout(5000) })
    if (r.ok) ok('图谱面板 8765', `HTTP ${r.status}`)
    else warn('图谱面板 8765', `HTTP ${r.status}`)
  } catch (e) {
    warn('图谱面板 8765', `连不上：${e.message}`)
  }

  // 模型目录路由：POST 带坏 key 只验「路由在不在」，不耗真实模型调用
  // （空 body → 400 即证明路由已注册；405 说明还是 SPA 兜底 = 没重启）
  try {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/dsh-tingxue/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${WEB_PORT}` },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20000),
    })
    const j = await r.json().catch(() => null)
    if (r.status === 405 || r.status === 404) {
      fail('模型目录路由未注册', `HTTP ${r.status} —— 被 GUI 的 SPA 兜底接管，说明 DSH 没在加路由之后重启`)
    } else if (r.status === 400) {
      ok('模型目录路由已注册', 'HTTP 400（空 body 被正常拒绝，证明路由在）')
    } else if (r.ok && j?.ok === false) {
      ok('模型目录路由已注册', `HTTP 200 且 ok:false（${j.error ?? '上游拒绝'}）——路由在，凭据或网络另说`)
    } else if (r.ok && j?.ok === true) {
      ok('模型目录路由已注册', `HTTP 200，${j.models?.length ?? '?'} 个模型`)
    } else {
      warn('模型目录路由', `HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 120)}`)
    }
  } catch (e) {
    fail('模型目录路由', `请求失败：${e.message}`)
  }
}

function checkInjection(state, dataDir, procStart) {
  const sid = state?.chatSessionId
  if (!sid) { warn('注入健康', 'state 里没有 chatSessionId，跳过'); return null }
  const log = findSessionLog(sid)
  if (!log) { warn('注入健康', `找不到会话日志（chatSessionId=${sid}）`); return null }

  const { events, totalFrames, fromFrame } = loadEvents(log, FULL ? null : 2000)
  const turns = analyzeTurns(events)
  if (turns.length === 0) { warn('注入健康', '日志里没有可用回合'); return null }

  const judged = turns.map(judgeTurn)

  // 只把**本次 DSH 启动之后**的回合当作现行判据：
  // 源码修复前的历史回合（如 turn 83/84）本来就该是漂移的，算进来只会误报。
  const afterBoot = procStart
    ? judged.filter((t) => t.firstAt && new Date(t.firstAt).getTime() >= procStart.getTime())
    : judged
  const scope = afterBoot.length ? afterBoot : judged
  const scopeNote = afterBoot.length
    ? (procStart ? `本次启动(${procStart.toLocaleTimeString('zh-CN', { hour12: false })})之后` : '')
    : '（拿不到启动时间，改用最近 6 轮）'

  const recent = afterBoot.length ? afterBoot : judged.slice(-6)
  const drifted = recent.filter((t) => t.drifted)

  if (drifted.length > 0) {
    fail('注入在同轮内变动（记忆块会消失）',
      `${scopeNote}的 ${recent.length} 轮里有 ${drifted.length} 轮 system 轮内变动：` +
      drifted.map((t) => `turn ${t.turn}(${t.lens.join('→')})`).join('、'))
  } else {
    const lens = [...new Set(recent.map((t) => t.sysLen))]
    ok('注入轮内恒定', `${scopeNote}${recent.length} 轮均无轮内变动；system 长度 ${lens.join(' / ')}`)
  }

  return {
    log, totalFrames, fromFrame,
    procStart: procStart ? procStart.toISOString() : null,
    scopeCount: scope.length,
    recent: recent.map((t) => ({
      turn: t.turn, steps: t.steps, headerCount: t.headerCount,
      changes: t.changes, lens: t.lens,
      mems: t.mems.map((m) => (m ? 'Y' : '-')),
      sysLen: t.sysLen, drifted: t.drifted,
    })),
    driftedInScope: drifted.length,
    turnsTotal: judged.length,
    lastSysLen: judged[judged.length - 1]?.sysLen,
    // 历史遗留（修复前的回合），仅供参考，不作为判定
    historicalDrift: judged.filter((t) => t.drifted && !recent.includes(t)).length,
  }
}

function checkNoDuplicateDshPrompt(events) {
  // 找最后一条 header，扫危险信号（这是「没把 DSH 本体一大坨塞进去」的判据）
  let last = null
  for (const e of events) if (e.type === 'request/header') last = e.data?.header
  if (!last?.system) return null
  const s = last.system
  const idLine = 'You are an AI agent powered by DeepSeek Harness.'
  const signals = {
    dshIdentityCount: s.split(idLine).length - 1,
    toolsTag: s.split('<tools>').length - 1,
    availableTools: s.split('Available tools').length - 1,
    functionCalls: s.split('function_calls').length - 1,
    recentRoundsBlock: s.split('\u3010\u6700\u8fd1\u5bf9\u8bdd\u3011').length - 1,
    latestInfoBlock: s.split('\u3010\u6700\u65b0\u4fe1\u606f\u3011').length - 1,
    personaBlock: s.split('\u3010\u8eab\u4efd\u4e0e\u5916\u89c2\u3011').length - 1,
    systemLen: s.length,
    toolCount: last.tools?.length ?? 0,
  }
  const bad = []
  if (signals.dshIdentityCount !== 1) bad.push(`DSH 身份行出现 ${signals.dshIdentityCount} 次（应为 1）`)
  if (signals.toolsTag > 0) bad.push(`<tools> 出现 ${signals.toolsTag} 次`)
  if (signals.availableTools > 0) bad.push(`Available tools 出现 ${signals.availableTools} 次`)
  if (signals.functionCalls > 0) bad.push(`function_calls 出现 ${signals.functionCalls} 次`)
  if (signals.recentRoundsBlock > 0) bad.push('【最近对话】仍在注入（[3] 应默认关闭）')

  if (bad.length === 0) {
    ok('无重复/累赘上下文',
      `${signals.systemLen} 字符 · ${signals.toolCount} 工具 · 人格块${signals.personaBlock ? '在' : '不在'} · 身份行 1 次`)
  } else {
    fail('上下文里有可疑内容', bad.join('；'))
  }
  return signals
}

// ---------- 主流程 ----------

async function main() {
  const dataDir = resolveDataDir()
  const cfg = readProfileConfig()

  const proc = await checkProcessFreshness()
  const state = checkSlidingWindow(dataDir)
  checkBinding(state, dataDir)
  await checkEndpoints(dataDir)

  const inj = checkInjection(state, dataDir, proc?.started ?? null)
  if (inj?.log) {
    const { events } = loadEvents(inj.log, FULL ? null : 2000)
    checkNoDuplicateDshPrompt(events)
  }

  // ---------- 输出 ----------
  const fails = findings.filter((f) => f.level === 'fail')
  const warns = findings.filter((f) => f.level === 'warn')

  if (AS_JSON) {
    console.log(JSON.stringify({
      ok: fails.length === 0,
      dataDir, profile: cfg.path, config: cfg,
      findings, injection: inj,
      summary: { fail: fails.length, warn: warns.length, ok: findings.length - fails.length - warns.length },
    }, null, 2))
  } else {
    const icon = { ok: '✓', warn: '!', fail: '✗' }
    console.log('')
    console.log('  听雪自检')
    console.log('  ' + '─'.repeat(56))
    for (const f of findings) {
      console.log(`  ${icon[f.level]} ${f.title}`)
      if (f.detail) console.log(`      ${f.detail}`)
    }
    if (inj?.recent?.length) {
      console.log('')
      console.log('  本进程启动后的回合（system 轮内变动 = 注入出问题）')
      console.log('  ' + '─'.repeat(56))
      console.log('   turn  steps  header  change  记忆块  system 长度          判定')
      for (const t of inj.recent) {
        const judge = t.drifted ? '轮内变动 ✗' : '恒定 ✓'
        const lens = t.lens.length === 1 ? String(t.lens[0]) : t.lens.join(' → ')
        console.log(`   ${String(t.turn).padStart(4)}  ${String(t.steps).padStart(5)}  ${String(t.headerCount).padStart(6)}  ${String(t.changes).padStart(6)}  ${t.mems.join(' ').padEnd(6)}  ${lens.padEnd(20)}${judge}`)
      }
      if (inj.historicalDrift > 0) {
        console.log('')
        console.log(`  （另有 ${inj.historicalDrift} 个修复前的历史回合存在同类变动，已排除在判定之外）`)
      }
    }
    console.log('')
    console.log('  ' + '─'.repeat(56))
    const verdict = fails.length === 0
      ? (warns.length === 0 ? '全部正常' : `正常（${warns.length} 项提示）`)
      : `${fails.length} 项失败${warns.length ? ` / ${warns.length} 项提示` : ''}`
    console.log(`  结论：${verdict}`)
    if (fails.length) {
      console.log('')
      console.log('  需要处理的：')
      for (const f of fails) console.log(`    ✗ ${f.title} —— ${f.detail}`)
    }
    console.log('')
  }

  process.exit(fails.length === 0 ? 0 : 1)
}

// 作为脚本直接运行才执行主流程；被 import（测试用）时只暴露纯函数。
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
  main().catch((e) => {
    console.error('自检崩溃：', e?.stack ?? e)
    process.exit(2)
  })
}

export { analyzeTurns, judgeTurn, loadEvents, findSessionLog }
