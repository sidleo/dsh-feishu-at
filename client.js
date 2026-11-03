/**
 * dsh-feishu-at —— Client 半（浏览器 bundle）。
 *
 * 向 DSH 的输入触发流水线注册一个 `@` 来源：敲 `@` 后由流水线接管菜单与键盘，
 * 本文件只负责「查候选 → 映射成菜单行 → 选中后插引用块 → 提交时序列化」。
 *
 * 候选来自 Host 半的同源路由 `api/dsh-feishu-at/search`（文档相对路径：GUI 带
 * `<base href="./">`，子路径部署下根绝对 `/api` 会 404）。搜索本身走本机 lark-cli，
 * 单次约 0.8–1.5s，因此这里做 120ms 去抖 + 60s 缓存 + 同 key 并发去重。
 *
 * 插入的块 `appearance` 故意省略：DSH 会渲染成「@ + 名称」的原子块；提交时按
 * `source: 'feishu'` 路由到本文件 codec.serialize，模型看到「名称 + ID + ID 类型」。
 */
window.__ModuleLoader__.load({
  id: '@sidleo3/dsh-feishu-at',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 搜索路由（文档相对路径，勿加前导 /）。 */
    const SEARCH_PATH = 'api/dsh-feishu-at/search'
    const DEBOUNCE_MS = 120
    const CACHE_TTL_MS = 60_000
    const MAX_CACHE_ENTRIES = 100
    const MAX_ITEMS = 20

    /** 分组小标题：按实体类型分节。 */
    const SECTIONS = { user: '飞书用户', chat: '飞书群聊', dept: '飞书部门' }

    // ── 图标（14×14，currentColor，跟随菜单文字色）────────────────────────

    /** 用户图标。 */
    function UserIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size || 14, height: size || 14,
        fill: 'currentColor', 'aria-hidden': true,
      }, h('path', { d: 'M8 8.2a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2Zm0 1.3c-3.1 0-5.6 1.8-5.6 4v.4c0 .4.3.7.7.7h9.8c.4 0 .7-.3.7-.7v-.4c0-2.2-2.5-4-5.6-4Z' }))
    }

    /** 群聊图标（对话气泡）。 */
    function ChatIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size || 14, height: size || 14,
        fill: 'currentColor', 'aria-hidden': true,
      }, h('path', { d: 'M2 3.5C2 2.7 2.7 2 3.5 2h9c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5H8.4l-3.2 2.7c-.3.3-.8.1-.8-.3v-2.4h-.9C2.7 11 2 10.3 2 9.5v-6Z' }))
    }

    /** 部门图标（组织树 / 楼）。 */
    function DeptIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size || 14, height: size || 14,
        fill: 'currentColor', 'aria-hidden': true,
      }, h('path', { d: 'M2 14V5.2c0-.3.2-.6.5-.6h3c.3 0 .5.3.5.6V7h4V3.2c0-.3.2-.6.5-.6h3c.3 0 .5.3.5.6V14h-5v-2.5H7.5V14H2Zm2-1.6h1.2V11H4v1.4Zm0-2.8h1.2V8.2H4v1.4Zm0-2.8h1.2V6.4H4v.6Zm7 5.6h1.2V11H11v1.4Zm0-2.8h1.2V8.2H11v1.4Z' }))
    }

    const ICONS = { user: UserIcon, chat: ChatIcon, dept: DeptIcon }

    // ── 候选取数：去抖 / 缓存 / 并发去重 / 静默降级 ────────────────────────

    /** q → { at, value }。 */
    const cache = new Map()
    /** q → 进行中的 Promise（同 key 并发共用）。 */
    const inflight = new Map()
    /** 网络/Host 失败只 warn 一次，避免菜单每敲一键刷控制台。 */
    let warned = false

    /** 等待 ms 毫秒，signal 取消时立即 reject。 */
    function delay(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        const timer = setTimeout(() => {
          if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        function onAbort() {
          clearTimeout(timer)
          reject(new DOMException('aborted', 'AbortError'))
        }
        if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true })
      })
    }

    /** 把 Host 响应写进缓存（LRU 上限）。 */
    function remember(key, value) {
      cache.set(key, { at: Date.now(), value })
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value)
    }

    /**
     * 取一次搜索结果：优先缓存，其次复用进行中的请求。
     * @param {string} q
     * @returns {Promise<any>}
     */
    function loadSearch(q) {
      const hit = cache.get(q)
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value)
      if (inflight.has(q)) return inflight.get(q)
      const pending = (async () => {
        try {
          const response = await fetch(`${SEARCH_PATH}?q=${encodeURIComponent(q)}&limit=${MAX_ITEMS}`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          remember(q, body)
          return body
        } catch (error) {
          if (!warned) {
            warned = true
            console.warn('[feishu-at] 飞书 @ 搜索不可用（Host 路由或 lark-cli 未就绪）：', error)
          }
          throw error
        } finally {
          inflight.delete(q)
        }
      })()
      inflight.set(q, pending)
      return pending
    }

    /** 解析引用块 ref（Host/本文件共用的 JSON 载荷）。 */
    function parseRef(ref) {
      try {
        const parsed = JSON.parse(ref)
        if (parsed && typeof parsed.id === 'string' && parsed.id && typeof parsed.n === 'string' && parsed.n) return parsed
      } catch {
        /* 非法引用 */
      }
      return null
    }

    /** Host 响应 items → 菜单候选。 */
    function toCandidates(body) {
      const items = Array.isArray(body?.items) ? body.items : []
      const candidates = []
      for (const item of items) {
        if (!item || typeof item.name !== 'string' || !item.name.trim() || typeof item.id !== 'string' || !item.id) continue
        candidates.push({
          name: item.name,
          label: item.name,
          description: typeof item.description === 'string' ? item.description : undefined,
          icon: ICONS[item.type] || UserIcon,
          section: typeof item.section === 'string' && item.section ? item.section : SECTIONS[item.type] || '飞书',
          value: JSON.stringify({ t: item.type, id: item.id, n: item.name, idType: item.idType || '' }),
        })
        if (candidates.length >= MAX_ITEMS) break
      }
      return candidates
    }

    /** 模型可见的提及文本：名称 + ID + ID 类型。 */
    function formatMention(ref) {
      const parsed = parseRef(ref)
      if (!parsed) return ref
      const labels = { user: '飞书用户', chat: '飞书群聊', dept: '飞书部门' }
      const idTypes = { user: 'open_id', chat: 'chat_id', dept: 'open_department_id' }
      const label = labels[parsed.t] || '飞书'
      const idType = parsed.idType || idTypes[parsed.t] || 'id'
      return `@${parsed.n}（${label}，${idType}=${parsed.id}）`
    }

    // ── @ 来源 ────────────────────────────────────────────────────────────

    const source = {
      trigger: '@',
      name: 'feishu',
      order: -10,
      showGroupTitle: false,

      /**
       * 查询候选。query 是 `@` 之后、光标之前的字符。
       * 去抖期间的取消、Host 未就绪都静默丢弃（本组候选消失，不影响文件/会话组）。
       */
      async candidates(_session, { query, quoted, signal }) {
        if (quoted === true) return []
        const q = String(query || '').slice(0, 50)
        try {
          await delay(DEBOUNCE_MS, signal)
        } catch {
          return []
        }
        if (signal && signal.aborted) return []
        try {
          const body = await loadSearch(q)
          if (signal && signal.aborted) return []
          return toCandidates(body)
        } catch {
          return []
        }
      },

      /** 会话 scope 出生时预热「最近群聊」，让一敲 @ 就有内容。 */
      warm() {
        if (cache.has('') && Date.now() - cache.get('').at < CACHE_TTL_MS) return
        void loadSearch('').catch(() => {})
      },

      /**
       * 选中：插入原子引用块。
       * 省略 appearance → 输入框内显示 `@` + 名称；提交时按 source 路由 codec。
       */
      onPick({ candidate }) {
        const parsed = parseRef(candidate.value)
        if (!parsed) return undefined
        return {
          insert: {
            source: 'feishu',
            ref: JSON.stringify(parsed),
            label: parsed.n,
            clipboardText: `@${parsed.n}`,
          },
        }
      },

      /** 点击输入框里的块：不做预览。 */
      openReference() {
        return false
      },

      /** 引用块的两套投影：剪贴板/草稿显示用名称，模型侧带完整元数据。 */
      codec: {
        clipboardText(ref) {
          const parsed = parseRef(ref)
          return parsed ? `@${parsed.n}` : ref
        },
        serialize(ref) {
          return Promise.resolve(formatMention(ref))
        },
      },
    }

    /** 注册来源；随插件卸载自动释放。 */
    function apply(ctx) {
      const inputTriggers = ctx.inputTriggers || (typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined)
      if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return
      ctx.effect(() => inputTriggers.registerSource(source), 'feishu-at: @ source')
    }

    return { inject: ['inputTriggers'], apply }
  },
})
