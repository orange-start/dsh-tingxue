// dsh-tingxue browser half — 设置在 Web GUI「设置 → 插件配置」里的一张卡片。
//
// 手写 lazy-CJS 工厂产物（本仓库外没有发布的 tsdown 预设，格式照
// dsh-vision-router / dsh-cost-meter 这类外部插件的做法复刻）：
// 客户端模块系统把整个文件包进 CJS factory，内核采纳 { apply, inject } 作为客户端插件。
//
// 纯自持：不导入任何其他插件的值（bundle 纯净度门禁），自带暂存表单与 revision 设栅。
// 只依赖 React 与三个服务：slots / locale / settingsScope。

window.__ModuleLoader__.load({
  id: 'dsh-tingxue',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useCallback } = React

    // ── i18n ────────────────────────────────────────────────────────────────
    const NS = 'settings.tingxue'
    const zh = {
      nav: '听雪',
      title: '听雪',
      subtitle: '双模式虚拟生命系统',
      description: '聊天模式与 agent 模式的人格、记忆库、模型、绑定与面板配置。改动在下次重启 DSH 后生效。',
      save: '保存',
      discard: '放弃',
      saving: '保存中…',
      overridden: '已覆盖',
      reset: '重置',
      loading: '读取中…',
      unavailable: '当前连接不可写（远程浏览器无法修改这些设置）。',
      unsaved: '有未保存的改动',
      saved: '已保存',
      invalidNumber: '请填数字',
      restartHint: '标注「已覆盖」的字段会覆盖部署配置；重置即回落到部署层。',
      // —— 模型选择器 ——
      pickModel: '选择模型',
      pickModelFor: '为「{field}」选择模型',
      fetching: '正在询问端点…',
      fetchFailed: '取列表失败',
      fetchEmpty: '端点没有列出任何模型，请手动填写。',
      fetchTitle: '选择要使用的模型',
      fetchDescription: '以下是该端点当前提供的模型，勾选要用的那个。',
      fetchSelect: '选用',
      fetchCancel: '取消',
      searchPlaceholder: '搜索模型 id…',
      noMatch: '没有匹配的模型。',
      manualHint: '也可以直接在输入框里手填模型 id。',
      currentBadge: '当前',
      modelCount: '共 {n} 个',
      close: '关闭',
    }
    const en = {
      nav: 'Tingxue',
      title: 'Tingxue',
      subtitle: 'dual-mode virtual life system',
      description: 'Persona, memory store, models, binding and panel settings. Changes apply after the next DSH restart.',
      save: 'Save',
      discard: 'Discard',
      saving: 'Saving…',
      overridden: 'overridden',
      reset: 'Reset',
      loading: 'Loading…',
      unavailable: 'This connection is read-only.',
      unsaved: 'Unsaved changes',
      saved: 'Saved',
      invalidNumber: 'Enter a number',
      restartHint: 'Overridden fields replace the deployment layer; resetting falls back to it.',
      // —— model picker ——
      pickModel: 'Choose model',
      pickModelFor: 'Choose a model for "{field}"',
      fetching: 'Asking the endpoint…',
      fetchFailed: 'Could not fetch the list',
      fetchEmpty: 'The endpoint listed no models; enter one by hand.',
      fetchTitle: 'Choose a model',
      fetchDescription: 'These are the models this endpoint currently serves.',
      fetchSelect: 'Use this',
      fetchCancel: 'Cancel',
      searchPlaceholder: 'Search model id…',
      noMatch: 'No matching model.',
      manualHint: 'You can also type a model id directly.',
      currentBadge: 'current',
      modelCount: '{n} models',
      close: 'Close',
    }
    /** t 缺失时回落到内嵌中文，卡片永不空着。 */
    function makeT(t) {
      return (key, fallback) => {
        if (typeof t === 'function') {
          try {
            const v = t(key)
            if (v && v !== key) return v
          } catch { /* 回落到内嵌文案 */ }
        }
        return fallback === undefined ? key : fallback
      }
    }

    // ── 模型目录 ────────────────────────────────────────────────────────────
    /**
     * 需要「从端点列表里挑」的字段：值是模型 id，端点就是模型后端本身。
     * 其余字段一律照旧手填 —— 选择器只加在这两处，不扩散到没必要的字段上。
     */
    const MODEL_FIELDS = new Set(['embeddingModel', 'llmModel'])

    /** 与 Host 半侧 MODEL_CATALOG_PATH 同一个路径。 */
    const CATALOG_PATH = '/dsh-tingxue/models'

    /**
     * 询问端点当前提供哪些模型。
     *
     * 走宿主自己的 webServer（和 GUI 同一个端口），所以不带跨源问题，也不用
     * 额外的 key。请求体是「表单当前显示的值」而不是已保存的配置：刚填进去、
     * 还没保存的端点或 key 也能立刻试。服务端只读，不写任何配置。
     *
     * @param {object} draft - { modelBackend, baseURL, apiKey }
     * @returns {Promise<{models?: Array<{id: string}>, error?: string}>}
     */
    async function fetchModels(draft) {
      try {
        const res = await fetch(CATALOG_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        })
        if (!res.ok) return { error: 'HTTP ' + res.status }
        const body = await res.json().catch(() => ({}))
        if (body && body.ok === true && Array.isArray(body.models)) return { models: body.models }
        return { error: (body && body.error) || 'unknown' }
      } catch (e) {
        return { error: (e && e.message) || String(e) }
      }
    }

    /**
     * 模型选择弹窗：照 DSH「设置 → 模型」的获取流程做的（询问端点 → 从候选里挑）。
     *
     * 与那份实现的两点差异，都是这里用不上的能力：不批量勾选（一次只选一个
     * 字段的值），不采纳容量元数据（听雪只关心模型 id）。搜索框是这里多出来的，
     * 因为 sta1n 的列表有 102 项，靠眼睛翻不现实。
     */
    function ModelPicker(props) {
      const tr = props.tr
      const [rows, setRows] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [query, setQuery] = React.useState('')

      const load = React.useCallback(() => {
        setBusy(true); setFailure(null)
        fetchModels(props.draft).then((r) => {
          setBusy(false)
          if (r.models) { setRows(r.models); if (r.models.length === 0) setFailure(tr('fetchEmpty', '端点没有列出任何模型，请手动填写。')); return }
          setFailure((r.error || '') + '')
        })
      }, [props.draft.modelBackend, props.draft.baseURL, props.draft.apiKey])

      React.useEffect(() => { load() }, [load])

      const all = rows || []
      const q = query.trim().toLowerCase()
      const shown = q === '' ? all : all.filter((m) => String(m.id).toLowerCase().includes(q))
      const current = props.currentValue

      const itemStyle = (isCurrent) => ({
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6,
        cursor: 'pointer', fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: isCurrent ? 'rgba(128,128,128,.14)' : 'transparent',
        border: '1px solid ' + (isCurrent ? 'var(--dsh-border, rgba(128,128,128,.45))' : 'transparent'),
      })

      return h('div', { style: S.overlay, onClick: (e) => { if (e.target === e.currentTarget) props.onClose() } },
        h('div', { style: S.modal, role: 'dialog', 'aria-label': tr('fetchTitle', '选择要使用的模型') },
          h('div', { style: S.modalHead },
            h('div', { style: { fontWeight: 600, fontSize: 13 } }, tr('pickModelFor', '选择模型').replace('{field}', props.fieldLabel)),
            h('span', { style: { flex: 1 } }),
            h('span', { style: S.badge }, busy ? tr('fetching', '正在询问端点…') : tr('modelCount', '共 {n} 个').replace('{n}', String(all.length))),
            h('button', { type: 'button', style: S.btn, onClick: props.onClose }, tr('close', '关闭')),
          ),
          h('div', { style: { fontSize: 11, opacity: 0.6, margin: '4px 0 8px' } }, tr('fetchDescription', '以下是该端点当前提供的模型，勾选要用的那个。')),
          h('input', {
            style: S.inputOnDark, type: 'text', value: query, autoFocus: true,
            placeholder: tr('searchPlaceholder', '搜索模型 id…'),
            onChange: (e) => { setQuery(e.target.value) },
          }),
          h('div', { style: S.modalBody },
            busy && all.length === 0 ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: 8 } }, tr('fetching', '正在询问端点…')) : null,
            failure ? h('div', { style: S.err }, tr('fetchFailed', '取列表失败') + '：' + failure) : null,
            !busy && !failure && shown.length === 0 ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: 8 } }, tr('noMatch', '没有匹配的模型。')) : null,
            ...shown.map((m) => h('div', {
              key: m.id, style: itemStyle(m.id === current),
              title: m.id,
              onClick: () => { props.onPick(String(m.id)); props.onClose() },
            },
              h('span', { style: { flex: 1, wordBreak: 'break-all' } }, String(m.id)),
              m.id === current ? h('span', { style: S.badge }, tr('currentBadge', '当前')) : null,
            )),
          ),
          failure || busy ? null : h('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 8 } }, tr('manualHint', '也可以直接在输入框里手填模型 id。')),
        ))
    }

    // ── 字段表（与 Host 半侧 src/settings/index.mjs 的 SETTINGS_FIELDS 对齐）──
    const FIELDS = [
      { key: 'profilePath', kind: 'string', group: '人格与记忆', label: '听雪档案路径', hint: '人格提示词 txt 的绝对路径' },
      { key: 'dataDir', kind: 'string', group: '人格与记忆', label: '记忆库目录', hint: 'LanceDB 本地文件即库的数据目录' },
      { key: 'recentRounds', kind: 'number', group: '人格与记忆', label: '最近 N 轮滑动窗口', hint: '注入上下文保留的最近对话轮数（仅打开「重复注入最近对话」时生效）' },
      { key: 'injectRecentRounds', kind: 'boolean', group: '人格与记忆', label: '重复注入最近对话', hint: '默认关。会话历史本身已含最近对话，再注入一遍等于同一段话付两次 token（约 1.5K/轮）。只有换绑到新会话、历史不可用时才需要打开' },
      { key: 'memoryBudgetTokens', kind: 'number', group: '人格与记忆', label: '记忆块预算', hint: '向量记忆检索块 token 上限' },
      { key: 'latestInfoBudgetTokens', kind: 'number', group: '人格与记忆', label: '最新信息块预算', hint: '最新信息块 token 上限' },
      { key: 'modelBackend', kind: 'enum', group: '模型', label: '模型后端', hint: 'sta1n 云端 / local 本地 / custom 自定义', values: ['sta1n', 'local', 'custom'] },
      { key: 'embeddingModel', kind: 'string', group: '模型', label: '向量模型', hint: '同库单一模型铁律：换模型须全量重嵌入。点「选择模型」可从当前端点列表里挑' },
      { key: 'embeddingDimensions', kind: 'number', group: '模型', label: '向量维度', hint: '须与向量模型实际输出一致' },
      { key: 'llmModel', kind: 'string', group: '模型', label: '语义推理小 LLM', hint: '实体抽取/摘要用的小模型。点「选择模型」可从当前端点列表里挑' },
      { key: 'baseURL', kind: 'string', group: '模型', label: '自定义端点', hint: 'local/custom 时的 OpenAI 兼容 base URL' },
      { key: 'apiKey', kind: 'secret', group: '模型', label: 'API Key', hint: '留空则回落到 DSH 凭据服务里的 STA1N_API_KEY' },
      { key: 'agentStartKeyword', kind: 'string', group: '双模式命令', label: '进入 agent 模式关键词', hint: 'QQ 聊天中触发隔离会话' },
      { key: 'agentStopKeyword', kind: 'string', group: '双模式命令', label: '退出 agent 模式关键词', hint: '归档并销毁隔离会话' },
      { key: 'fileDeleteScope', kind: 'enum', group: '双模式命令', label: '文件删除范围', hint: 'workcopy 只删工作副本 / keep 一律保留', values: ['workcopy', 'keep'] },
      { key: 'channel', kind: 'string', group: '绑定与推送', label: '绑定通道', hint: 'dsh-notifier 的 channel' },
      { key: 'userId', kind: 'string', group: '绑定与推送', label: '绑定用户', hint: 'dsh-notifier 的 userId' },
      { key: 'chatSessionId', kind: 'string', group: '绑定与推送', label: '聊天会话 id', hint: '自愈回绑用的可信聊天会话 id' },
      { key: 'notifierStateFile', kind: 'string', group: '绑定与推送', label: 'notifier state 路径', hint: '留空用默认的 dsh-notifier state.json' },
      { key: 'routeWorkspace', kind: 'string', group: '绑定与推送', label: '出站分流 workspace', hint: '被静音的默认 workspace' },
      { key: 'quietOtherWorkspace', kind: 'boolean', group: '绑定与推送', label: '静音其他会话推送', hint: '只让听雪自己的消息送达 QQ' },
      { key: 'qqStatusNotice', kind: 'boolean', group: '绑定与推送', label: 'QQ 显示任务状态提示', hint: '关掉后不再发任务开始/完成/中止/心跳/疑似卡住这类状态行；回复正文照常送达（出错通知仍保留）' },
      { key: 'approvalAllowlistOnly', kind: 'boolean', group: '绑定与推送', label: '审批只推 QQ 对话会话', hint: '只有听雪聊天会话 / agent 隔离会话的批准询问发到 QQ，其他 DSH 会话的审批只在桌面弹' },
      { key: 'graphDashboardEnable', kind: 'boolean', group: '面板与服务', label: '启用关系图谱面板', hint: '本机可交互蜘蛛网 UI' },
      { key: 'graphDashboardHost', kind: 'string', group: '面板与服务', label: '图谱面板监听地址', hint: '默认仅本机 loopback' },
      { key: 'graphDashboardPort', kind: 'number', group: '面板与服务', label: '图谱面板端口', hint: '' },
      { key: 'memoryServiceEnable', kind: 'boolean', group: '面板与服务', label: '启用记忆服务', hint: 'DSH 唯一写者，AstrBot 经 HTTP 对接' },
      { key: 'memoryServiceHost', kind: 'string', group: '面板与服务', label: '记忆服务监听地址', hint: '默认仅本机 loopback' },
      { key: 'memoryServicePort', kind: 'number', group: '面板与服务', label: '记忆服务端口', hint: '' },
    ]
    const GROUPS = ['人格与记忆', '模型', '双模式命令', '绑定与推送', '面板与服务']

    // ── 极简 snapshot store（HostObservable：getSnapshot + subscribe）────────
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (fn) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
        set: (next) => {
          snapshot = next
          for (const fn of Array.from(listeners)) {
            try { fn() } catch { /* 单个订阅者失败不影响其他 */ }
          }
        },
      }
    }

    const fmt = (v) => (v === undefined || v === null ? '' : String(v))
    const jsonEqual = (a, b) => {
      if (a === b) return true
      if (typeof a !== typeof b) return false
      if (a === null || b === null) return false
      if (typeof a !== 'object') return false
      try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
    }
    /** 把草稿文本解析成该字段的类型。 */
    function parseDraft(text, field) {
      if (field.kind === 'number') {
        const n = Number(String(text).trim())
        if (String(text).trim() === '' || !Number.isFinite(n)) return { invalid: true }
        return { value: n }
      }
      if (field.kind === 'boolean') return { value: text === 'true' }
      return { value: String(text) }
    }

    /** 卡片控制器：scope → 暂存表单 → 快照。 */
    function createCardController(scope) {
      const drafts = new Map()
      let saving = false
      let error = null
      let store = null

      const scopeSnapshot = () => {
        try { return scope.getSnapshot?.() ?? {} } catch { return {} }
      }

      function project() {
        const snap = scopeSnapshot()
        const value = (snap && snap.value) || {}
        const base = (snap && snap.base) || {}
        const user = (snap && snap.user) || {}
        const fields = FIELDS.map((f) => {
          const hasDraft = drafts.has(f.key)
          const resolved = value[f.key]
          const draft = hasDraft ? drafts.get(f.key) : fmt(resolved)
          const parsed = hasDraft ? parseDraft(draft, f) : { value: resolved }
          return {
            key: f.key, kind: f.kind, group: f.group, label: f.label, hint: f.hint,
            values: f.values,
            draft,
            value: resolved,
            base: base[f.key],
            overridden: Object.prototype.hasOwnProperty.call(user, f.key),
            invalid: hasDraft ? parsed.invalid === true : false,
          }
        })
        return {
          status: snap.status ?? 'loading',
          writable: snap.writable === true,
          saving,
          error,
          dirty: drafts.size > 0,
          fields,
        }
      }
      function push() { if (store) store.set(project()) }

      store = createStore(project())
      try {
        const off = scope.subscribe?.(() => { push() })
        if (typeof off === 'function') store.dispose = off
      } catch { /* 无订阅能力时退化为手动刷新 */ }

      return {
        store,
        edit(field, text) { drafts.set(field, text); push() },
        discard() { drafts.clear(); error = null; push() },
        reseed() { drafts.clear(); error = null; push() },
        async resetField(field) {
          drafts.delete(field)
          try {
            await scope.unset?.(field)
            error = null
          } catch (e) { error = (e && e.message) || String(e) }
          push()
        },
        async save() {
          const value = (scopeSnapshot().value) || {}
          const bad = FIELDS.filter((f) => drafts.has(f.key) && parseDraft(drafts.get(f.key), f).invalid === true)
          if (bad.length > 0) {
            error = bad.map((f) => f.label).join('、') + '：' + '请填数字'
            push()
            return
          }
          saving = true; error = null; push()
          const failures = []
          for (const f of FIELDS) {
            if (!drafts.has(f.key)) continue
            const parsed = parseDraft(drafts.get(f.key), f)
            if (jsonEqual(parsed.value, value[f.key])) { drafts.delete(f.key); continue }
            try {
              await scope.set?.(f.key, parsed.value)
              drafts.delete(f.key)
            } catch (e) {
              failures.push(((e && e.message) || String(e)))
            }
          }
          saving = false
          error = failures.length > 0 ? failures.join('；') : null
          push()
        },
        inject() {
          // hooks 隔间在渲染侧绑定成 useCard 选择器钩子；其余成员原样成为 props。
          return {
            hooks: { card: store },
            save: () => { void this.save() },
            discard: () => { this.discard() },
            edit: (field, text) => { this.edit(field, text) },
            resetField: (field) => { void this.resetField(field) },
          }
        },
      }
    }

    // ── 样式（内联，自带外观）────────────────────────────────────────────────
    const S = {
      page: { padding: '2px 2px 24px' },
      pageTitle: { fontSize: 16, fontWeight: 600 },
      head: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      badge: { fontSize: 11, opacity: 0.75, border: '1px solid currentColor', borderRadius: 999, padding: '0 6px' },
      desc: { fontSize: 12, opacity: 0.7, margin: '6px 0 10px', lineHeight: 1.5 },
      groupTitle: { fontSize: 11, fontWeight: 600, opacity: 0.6, margin: '12px 0 6px', letterSpacing: '.04em' },
      row: { display: 'grid', gridTemplateColumns: '220px 1fr auto', gap: 8, alignItems: 'center', padding: '3px 0' },
      label: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      hint: { fontSize: 11, opacity: 0.55, display: 'block', marginTop: 1 },
      input: { width: '100%', boxSizing: 'border-box', padding: '4px 8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit' },
      /**
       * 模型选择弹窗的搜索框专用样式：明确的白底 + 深色字。
       *
       * 不复用 S.input —— 那份是「贴合宿主主题」的设置输入框（transparent + inherit），
       * 而弹窗自带一块深色底，两者叠在一起时主题色会失灵。这里就按弹窗自己的底色配
       * 一套固定配色：白底 #fff、字 #1b1b1f（对比度约 19:1）。
       *
       * placeholder 不写死颜色：内联样式管不到 ::placeholder，浏览器用的是宿主主题配色。
       * 但无论宿主那条规则是 currentColor+opacity（跟随这里的 #1b1b1f）还是 UA 默认的
       * 深灰，落在白底上都能看清 —— 关键只是别让底色再是透明的。
       */
      inputOnDark: {
        width: '100%', boxSizing: 'border-box', padding: '6px 10px', fontSize: 12, borderRadius: 6,
        border: '1px solid #3f3f46', background: '#ffffff', color: '#1b1b1f',
        caretColor: '#1b1b1f', outline: 'none',
      },
      reset: { fontSize: 11, padding: '2px 7px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      btn: { fontSize: 12, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      err: { fontSize: 12, color: '#d9534f', marginTop: 8 },
      meta: { fontSize: 11, opacity: 0.6, marginTop: 8 },
      // —— 模型选择弹窗 ——
      overlay: {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      },
      modal: {
        width: 'min(560px, 100%)', maxHeight: 'min(70vh, 560px)', display: 'flex', flexDirection: 'column',
        // 弹窗自带固定深底，所以前景也必须固定：color:'inherit' 会从宿主设置页继承，
        // 在浅色主题下就是「深底 + 深字」，标题/说明/列表项全部看不见（实测 1.04:1）。
        background: 'var(--dsh-bg, #1b1b1f)', color: 'var(--dsh-fg, #e8e8ea)', borderRadius: 12,
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', padding: '14px 16px',
        boxShadow: '0 18px 48px rgba(0,0,0,.4)',
      },
      modalHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 },
      modalBody: { flex: 1, overflowY: 'auto', marginTop: 8, paddingRight: 2 },
    }

    // ── 设置侧边栏页面 ──────────────────────────────────────────────────────
    /**
     * 设置侧边栏里的独立一页（导航项「听雪」）。
     *
     * 只注册这一个入口：早先还在「设置 → 插件 → 插件配置」里挂过同一份设置的第二张
     * 卡片，两处渲染同一个控制器、内容完全重复，用户明确要求只留侧边栏这一处。
     */
    function TingxueSection(props) {
      const tr = makeT(props.t)
      const state = props.useCard ? props.useCard((s) => s) : undefined
      // 命名与侧边栏 nav 统一成「听雪」；「双模式虚拟生命系统」降为下方说明行。
      const heading = () => h('span', { style: S.pageTitle }, tr('title', '听雪'))
      if (!state || state.status === 'loading') {
        return h('div', { style: S.page }, heading(), h('div', { style: S.desc }, tr('loading', '读取中…')))
      }
      if (state.status === 'unavailable' || !state.writable) {
        return h('div', { style: S.page }, heading(), h('div', { style: S.desc }, tr('unavailable', '当前连接不可写。')))
      }

      const groupNodes = GROUPS.map((g) => {
        const rows = state.fields.filter((f) => f.group === g)
        if (rows.length === 0) return null
        // 模型选择器要看「同一个表单里当前的」后端/端点/key，所以从本组已投影的
        // 字段里取草稿值（含未保存的改动），而不是读已保存的配置。
        const draftOf = (key) => {
          const hit = state.fields.find((f) => f.key === key)
          return hit ? String(hit.draft ?? '') : ''
        }
        const draft = {
          modelBackend: draftOf('modelBackend') || 'sta1n',
          baseURL: draftOf('baseURL'),
          apiKey: draftOf('apiKey'),
        }
        return h('div', { key: g },
          h('div', { style: S.groupTitle }, g),
          ...rows.map((f) => h(FieldRow, { key: f.key, f, tr, props, draft })),
        )
      })

      const head = h('div', { style: S.head },
        heading(),
        state.dirty ? h('span', { style: S.badge }, tr('unsaved', '有未保存的改动')) : null,
        h('span', { style: { flex: 1 } }),
        h('button', {
          type: 'button', style: S.btn, disabled: state.saving || !state.dirty,
          onClick: () => { props.discard && props.discard() },
        }, tr('discard', '放弃')),
        h('button', {
          type: 'button', style: S.btn, disabled: state.saving || !state.dirty,
          onClick: () => { props.save && props.save() },
        }, state.saving ? tr('saving', '保存中…') : tr('save', '保存')),
      )

      return h('div', { style: S.page },
        head,
        h('div', { style: S.desc }, tr('subtitle', '双模式虚拟生命系统')),
        h('div', { style: S.desc }, tr('description', '聊天模式与 agent 模式的人格、记忆库、模型、绑定与面板配置。改动在下次重启 DSH 后生效。')),
        ...groupNodes,
        state.error ? h('div', { style: S.err }, state.error) : null,
        h('div', { style: S.meta }, tr('restartHint', '标注「已覆盖」的字段会覆盖部署配置；重置即回落到部署层。')),
      )
    }

    /** 一个字段行：控件 + 覆盖标记 + 重置。 */
    function FieldRow(input) {
      const { f, tr, props, draft } = input
      const [picking, setPicking] = React.useState(false)
      const disabled = false
      const onEdit = (text) => { props.edit && props.edit(f.key, text) }
      // 只有模型 id 字段带选择器：值是端点上的一个 id，端点就是模型后端本身。
      const pickable = MODEL_FIELDS.has(f.key) && draft !== undefined
      const control = (() => {
        if (f.kind === 'boolean') {
          return h('input', {
            type: 'checkbox', checked: f.draft === 'true', disabled,
            style: { width: 15, height: 15 },
            onChange: (e) => { onEdit(e.target.checked ? 'true' : 'false') },
          })
        }
        if (f.kind === 'enum') {
          return h('select', {
            style: S.input, value: f.draft, disabled,
            onChange: (e) => { onEdit(e.target.value) },
          }, ...(f.values || []).map((v) => h('option', { key: v, value: v }, v)))
        }
        return h('input', {
          type: f.kind === 'number' ? 'number' : 'text',
          style: S.input, value: f.draft, disabled,
          'aria-invalid': f.invalid ? 'true' : undefined,
          onChange: (e) => { onEdit(e.target.value) },
        })
      })()

      // 弹窗挂在这一行的外层：放进行内会让它成为网格的第 4 个单元，
      // 把三列（标签/控件/重置）的排布挤歪。
      return h('div', null,
        h('div', { style: S.row },
          h('div', { style: S.label },
            h('span', null, f.label),
            f.overridden ? h('span', { style: S.badge }, tr('overridden', '已覆盖')) : null,
            f.hint ? h('span', { style: S.hint }, f.hint) : null,
          ),
          h('div', null,
            h('div', { style: pickable ? { display: 'flex', gap: 6, alignItems: 'flex-end' } : undefined },
              h('div', { style: pickable ? { flex: 1, minWidth: 0 } : undefined },
                control,
                f.invalid ? h('span', { style: { fontSize: 11, color: '#d9534f' } }, tr('invalidNumber', '请填数字')) : null,
              ),
              pickable ? h('button', {
                type: 'button', style: S.btn, title: tr('pickModel', '选择模型'),
                onClick: () => { setPicking(true) },
              }, tr('pickModel', '选择模型')) : null,
            ),
          ),
          f.overridden
            ? h('button', {
              type: 'button', style: S.reset, title: tr('reset', '重置'),
              onClick: () => { props.resetField && props.resetField(f.key) },
            }, tr('reset', '重置'))
            : h('span', null),
        ),
        picking ? h(ModelPicker, {
          tr, draft, currentValue: String(f.draft ?? ''), fieldLabel: f.label,
          onPick: (id) => { onEdit(id) },
          onClose: () => { setPicking(false) },
        }) : null,
      )
    }

    // ── 插件 apply ──────────────────────────────────────────────────────────
    /** 设置命名空间——与 Host 半侧 TINGXUE_SETTINGS_NS 同一个键。 */
    const TINGXUE_NS = 'dsh-tingxue'

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tingxue: dictionaries')

      const scope = ctx.settingsScope.bind({ namespace: TINGXUE_NS })
      const card = createCardController(scope)

      // 唯一入口：设置侧边栏里的独立一页（导航项「听雪」，排在 agent-presets 之后）。
      // 不再注册 settings.plugin.item 的第二张卡片：两处渲染同一份设置，纯重复。
      // Host 半侧的命名空间注册（src/settings/index.mjs）与浏览器侧入口无关，
      // 所以去掉卡片不影响保存链路。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'tingxue',
        order: 26,
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
        inject: () => card.inject(),
      }, TingxueSection))
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'settingsScope']
    return module.exports
  },
})
