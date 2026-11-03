/**
 * dsh-feishu-at —— Host 半。
 *
 * 职责：用本机 `lark-cli`（user 身份）搜索飞书「用户 / 群聊 / 部门」，经
 * `GET /api/dsh-feishu-at/search`、`GET /api/dsh-feishu-at/status` 两个同源路由
 * 提供给浏览器半（client.js），后者把它注册成输入框的 `@` 候选来源。
 *
 * 设计要点：
 * - **进程 PATH 不可信**：macOS 上从 Dock/Finder 启动的 GUI 进程 PATH 只有
 *   `/usr/bin:/bin:/usr/sbin:/sbin`，直接 `spawn('lark-cli')` 会 ENOENT；这里照
 *   dsh-wiki 的做法探测 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`，
 *   并给子进程补上 lark-cli 所在目录（它常是 `#!/usr/bin/env node` 的 shim）。
 * - **交互性能**：每条 lark-cli 约 0.8–1.5s。三路并行 + 内存 TTL 缓存 + 同 key
 *   并发去重，避免每敲一个字都冷启动三次。
 * - **永不 500**：搜索路由任何失败都返回 200 + 空 items + issues，菜单侧把 issue 渲染成提示行。
 * - **私聊补全**：飞书的群聊搜索接口不返回私聊，模糊搜索用本地「群聊 + 私聊」会话索引
 *   （`im +chat-list --types p2p,group`，缓存 10min、加载时预热）按名称过滤。
 * - **权限降级**：当前 user token 没有「部门基础信息」读权限（`contact:department.base:readonly`），
 *   部门搜索只回 `open_department_id`。探测一次后缓存结论，按 id 降级返回并提示授权命令。
 */

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 插件行 id（与 cordis.patch.yml 的 id 一致）。 */
export const name = 'feishu-at'
/** 需要 webServer 才能注册路由；非 Web 部署下本插件不激活。 */
export const inject = ['webServer']

const ROUTES = {
  search: '/api/dsh-feishu-at/search',
  status: '/api/dsh-feishu-at/status',
}

const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_CACHE_TTL_MS = 120_000
const STATUS_CACHE_TTL_MS = 30_000
const RECENT_CACHE_TTL_MS = 60_000
const DEPT_NAMES_TTL_MS = 10 * 60_000
/** 会话全量索引（群聊 + 私聊）缓存 TTL；失败时用短 TTL 重试。 */
const CHAT_INDEX_TTL_MS = 10 * 60_000
const CHAT_INDEX_RETRY_TTL_MS = 60_000
const CHAT_INDEX_TIMEOUT_MS = 20_000
const CHAT_INDEX_PAGE_SIZE = 100
const CHAT_INDEX_PAGE_LIMIT = 20
const MAX_CACHE_ENTRIES = 200
const MAX_QUERY_LENGTH = 50
const MAX_LIMIT = 20
const TYPES = new Set(['user', 'chat', 'dept'])

const LARK_MISSING_HINT = '未找到 lark-cli：安装后执行 `lark-cli auth login`，或在插件 config 里指定 larkCliPath'
const LARK_INSTALL_FIX = 'npm i -g @larksuite/cli && lark-cli config init && lark-cli auth login'
const LARK_LOGIN_FIX = 'lark-cli auth login'

// ───────────────────────────── 安装 / 授权问题 ─────────────────────────────
//
// 其他用户装本插件时最常见的失败不是代码错，而是本机 lark-cli 不存在、没配飞书应用、
// 没登录、或登录的 user 授权缺 scope。Host 把这类失败归成结构化的 issue 交给
// client 渲染成菜单里的提示行（选中无动作），用户就知道该跑哪条命令；搜索路由
// 「永不 500」的契约保持不变。

/**
 * 生成一条可展示/可自查的 issue。
 * @param {string} kind - 机器可读分类：cli-missing | not-configured | auth-required | scope-missing | dept-names | search-failed | route-missing
 * @param {string} title - 菜单提示行的标题
 * @param {string} detail - 一行细节（报错原文摘要）
 * @param {string} fix - 可直接复制执行的修复命令/步骤
 * @param {string[]} [scopes] - 缺失的 scope 清单
 * @returns {{kind: string, title: string, detail: string, fix: string, scopes?: string[]}}
 */
function makeIssue(kind, title, detail, fix, scopes) {
  const issue = { kind, title, detail: String(detail || '').trim().slice(0, 200), fix }
  if (Array.isArray(scopes) && scopes.length) issue.scopes = scopes
  return issue
}

/** lark-cli 不存在。 */
function cliMissingIssue() {
  return makeIssue('cli-missing', '未安装 lark-cli', '本机找不到 lark-cli，插件无法搜索飞书目录', LARK_INSTALL_FIX)
}

/** 部门名称缺 scope（非致命，部门行降级为 ID）。 */
function deptScopeIssue() {
  return makeIssue('dept-names', '部门名称无权限', '当前授权缺少部门读权限，部门行只显示 open_department_id', 'lark-cli auth login --scope contact:department.base:readonly', ['contact:department.base:readonly'])
}

/**
 * 把 lark-cli 的失败归成结构化 issue。
 * @param {string} [text] - stderr/输出原文
 * @param {any} [json] - 解析到的错误信封 `{ok:false,error:{...}}`
 * @param {{missing?: boolean}} [flags]
 * @returns {{kind: string, title: string, detail: string, fix: string, scopes?: string[]}}
 */
function classifyLarkError(text, json, flags = {}) {
  if (flags.missing) return cliMissingIssue()
  const err = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error : null
  const message = String(err?.message || text || 'lark-cli 执行失败').trim()
  const scopes = Array.isArray(err?.missing_scopes) ? err.missing_scopes.filter((scope) => typeof scope === 'string' && scope) : []
  const hay = `${err?.type || ''} ${err?.subtype || ''} ${message} ${text || ''}`.toLowerCase()
  if (scopes.length || hay.includes('does not cover the required scope') || hay.includes('missing_scope')) {
    return makeIssue(
      'scope-missing',
      '飞书授权缺少 scope',
      scopes.length ? `缺少：${scopes.join('、')}` : message,
      scopes.length ? `lark-cli auth login --scope "${scopes.join(' ')}"` : 'lark-cli auth login --scope "<报错中的 scope>"',
      scopes,
    )
  }
  if (/config init|not configured|invalid_config|app[ _-]?id/.test(hay)) {
    return makeIssue('not-configured', 'lark-cli 未配置飞书应用', message, 'lark-cli config init（填 app-id / app-secret，再 lark-cli auth login）')
  }
  if (/auth login|not logged in|no current user identity|token_missing|token_invalid|session expired|no user token|needs user identity/.test(hay)) {
    return makeIssue('auth-required', '飞书未登录', message, LARK_LOGIN_FIX)
  }
  return makeIssue('search-failed', '飞书搜索失败', message, '')
}

/**
 * 清空进程内缓存与探测结论（测试用；不影响运行期行为）。
 */
export function resetForTests() {
  searchCache.clear()
  statusCache.clear()
  state.deptNames = { value: undefined, at: 0 }
  state.lastIssues = null
  chatIndexState = { at: 0, ttl: 0, value: [] }
  chatIndexInflight = null
  requestLog.length = 0
}

/** issue 去重（同 kind + 同 fix 视为同一条）。 */
function dedupeIssues(issues) {
  const seen = new Set()
  const out = []
  for (const issue of issues) {
    if (!issue) continue
    const key = `${issue.kind}|${issue.fix}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(issue)
  }
  return out
}

// ───────────────────────────── lark-cli 进程 ─────────────────────────────

/**
 * lark-cli 落点候选（PATH 里没有时的回退）。
 * @returns {string[]} 绝对路径候选
 */
function larkCandidates() {
  return [
    join(homedir(), '.local', 'bin', 'lark-cli'),
    '/opt/homebrew/bin/lark-cli',
    '/usr/local/bin/lark-cli',
  ]
}

/**
 * 可执行文件存在且可执行？（避免挑到无 +x 的残文件后报 EACCES 而非 ENOENT）
 * @param {string} path
 * @returns {boolean}
 */
function runnable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 解析 lark-cli 可执行文件与子进程需要的 PATH。
 * @param {string|undefined} explicit - 配置里显式指定的路径
 * @returns {{bin: string, path: string|null, found: boolean}}
 */
function resolveLarkCli(explicit) {
  if (explicit) return { bin: explicit, path: null, found: runnable(explicit) }
  const path = String(process.env.PATH || '')
  if (path.split(':').filter(Boolean).some((dir) => runnable(join(dir, 'lark-cli')))) {
    return { bin: 'lark-cli', path: null, found: true }
  }
  for (const candidate of larkCandidates()) {
    if (!runnable(candidate)) continue
    const dir = dirname(candidate)
    const nextPath = path.split(':').includes(dir) ? null : [dir, path].filter(Boolean).join(':')
    return { bin: candidate, path: nextPath, found: true }
  }
  return { bin: 'lark-cli', path: null, found: false }
}

/** 把 stdout 解析成 JSON；不是 JSON 时返回 null。 */
function tryJson(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/**
 * 执行一条 lark-cli 命令；永不 reject。
 * @param {string[]} args
 * @param {{bin?: string, timeoutMs?: number, envPath?: string|null}} opts
 * @returns {Promise<{ok: boolean, json: any, error?: string}>}
 */
function runLark(args, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    const lark = resolveLarkCli(opts.bin)
    if (!lark.found) {
      resolve({ ok: false, json: null, error: LARK_MISSING_HINT, missing: true })
      return
    }
    execFile(
      lark.bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        shell: false,
        env: lark.path === null ? { ...process.env } : { ...process.env, PATH: lark.path },
      },
      (err, stdout, stderr) => {
        const out = String(stdout || '')
        const errText = String(stderr || '')
        if (!err) {
          resolve({ ok: true, json: tryJson(out) })
          return
        }
        const code = typeof err.code === 'number' ? err.code : null
        if (err.code === 'ENOENT') {
          resolve({ ok: false, json: null, error: LARK_MISSING_HINT })
          return
        }
        if (err.killed || code === null) {
          resolve({ ok: false, json: null, error: `lark-cli 执行超时（${timeoutMs}ms）：${args.slice(0, 3).join(' ')}` })
          return
        }
        resolve({
          ok: false,
          json: tryJson(out),
          error: (errText || out || `lark-cli ${args.slice(0, 3).join(' ')} 失败（exit ${code}）`).trim().slice(0, 500),
        })
      },
    )
  })
}

/**
 * 解包 lark-cli 的 `{ok, data}` 信封；失败统一转成结构化 issue。
 * @param {{ok: boolean, json: any, error?: string, missing?: boolean}} res
 * @returns {{ok: true, data: any} | {ok: false, issue: object}}
 */
function unwrap(res) {
  if (!res.ok) return { ok: false, issue: classifyLarkError(res.error, res.json, { missing: res.missing }) }
  const json = res.json
  if (json && json.ok === false) return { ok: false, issue: classifyLarkError(null, json) }
  if (json && typeof json === 'object' && 'data' in json) return { ok: true, data: json.data }
  return { ok: false, issue: makeIssue('search-failed', '飞书搜索失败', 'lark-cli 返回格式异常', '') }
}

// ───────────────────────────── 缓存 ─────────────────────────────

/** 极简 TTL + LRU 缓存（key → {at, ttl, value}），并做同 key 并发去重。 */
class TimedCache {
  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this.maxEntries = maxEntries
    this.map = new Map()
    this.inflight = new Map()
  }

  /**
   * 取缓存；未命中时执行 loader（同 key 并发共用一次 loader）。
   * @param {string} key
   * @param {number} ttl
   * @param {() => Promise<any>} loader
   * @returns {Promise<any>}
   */
  async get(key, ttl, loader) {
    const now = Date.now()
    const hit = this.map.get(key)
    if (hit && now - hit.at < hit.ttl) return hit.value
    if (this.inflight.has(key)) return this.inflight.get(key)
    const pending = (async () => {
      try {
        const value = await loader()
        this.map.set(key, { at: Date.now(), ttl, value })
        while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value)
        return value
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, pending)
    return pending
  }

  /** 清空（测试/调试用）。 */
  clear() {
    this.map.clear()
    this.inflight.clear()
  }
}

// ───────────────────────────── 三个搜索域 ─────────────────────────────

/** 配置归一化。 */
function normalizeConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  return {
    larkCliPath: typeof cfg.larkCliPath === 'string' && cfg.larkCliPath ? cfg.larkCliPath : undefined,
    timeoutMs: Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
    cacheTtlMs: Number.isFinite(cfg.cacheTtlMs) ? cfg.cacheTtlMs : DEFAULT_CACHE_TTL_MS,
    identity: 'user',
  }
}

/** 截断部门路径，只留末两级（如「某部门-分部」）。 */
function departmentTail(department) {
  const text = String(department || '').trim()
  if (!text) return ''
  const parts = text.split(/[-/]/).filter(Boolean)
  return parts.slice(-2).join('-')
}

/** 用户候选。 */
async function searchUsers(q, limit, cfg) {
  const res = await runLark(
    ['contact', '+search-user', '--query', q, '--as', cfg.identity, '--format', 'json', '--page-size', String(Math.min(Math.max(limit, 1), 30))],
    { bin: cfg.larkCliPath, timeoutMs: cfg.timeoutMs },
  )
  const unwrapped = unwrap(res)
  if (!unwrapped.ok) return { items: [], issue: unwrapped.issue }
  const users = Array.isArray(unwrapped.data?.users) ? unwrapped.data.users : []
  const items = []
  for (const user of users) {
    const displayName = String(user.localized_name || '').trim()
    if (!displayName) continue
    const department = String(user.department || '').trim()
    const tail = departmentTail(department)
    items.push({
      type: 'user',
      name: displayName,
      id: String(user.open_id || ''),
      idType: 'open_id',
      description: tail ? `${tail} · open_id ${user.open_id || ''}` : `open_id ${user.open_id || ''}`,
      department,
    })
    if (items.length >= limit) break
  }
  return { items }
}

/**
 * 群聊 / 私聊候选。`chat_mode === 'p2p'` 的是私聊（`p2p_target_type` 为 user 或 bot），
 * 其余按群聊处理；两者都用 chat_id 作为 ID 类型。
 */
function mapChat(chat) {
  const displayName = String(chat.name || '').trim()
  if (!displayName) return null
  const chatId = String(chat.chat_id || '')
  if (chat.chat_mode === 'p2p') {
    const kind = chat.p2p_target_type === 'bot' ? '机器人私聊' : '私聊'
    return { type: 'p2p', name: displayName, id: chatId, idType: 'chat_id', description: `${kind} · chat_id ${chatId}` }
  }
  const description = String(chat.description || '').trim()
  const external = chat.external === true ? '外部群 · ' : ''
  return {
    type: 'chat',
    name: displayName,
    id: chatId,
    idType: 'chat_id',
    description: `${external}${description ? `${description.slice(0, 40)} · ` : ''}chat_id ${chatId}`,
  }
}

/**
 * 会话全量索引（群聊 + 私聊），供模糊搜索本地过滤。
 * `im +chat-search` 只返回群聊、不返回私聊，所以私聊要靠这份索引按名称匹配；
 * 索引按活跃时间倒序，首次拉取约 3–4s（数百个会话），之后缓存 10 分钟；
 * 拉取失败按空索引缓存 60s，搜索自动退回「仅服务端群聊」。
 * @param {object} cfg
 * @returns {Promise<any[]>} raw chats（含 chat_id / name / chat_mode / p2p_target_type）
 */
/** 拉取一次会话索引并入缓存；并发去重。 */
function refreshChatIndex(cfg) {
  if (chatIndexInflight) return chatIndexInflight
  chatIndexInflight = (async () => {
    // 刷新失败时保留旧索引（不要清空）；没有旧索引才用空数组等下次重试。
    let value = chatIndexState.value || []
    let ttl = CHAT_INDEX_RETRY_TTL_MS
    try {
      const res = await runLark(
        ['im', '+chat-list', '--types', 'p2p,group', '--sort', 'active_time', '--page-all',
          '--page-size', String(CHAT_INDEX_PAGE_SIZE), '--page-limit', String(CHAT_INDEX_PAGE_LIMIT),
          '--as', cfg.identity, '--format', 'json'],
        { bin: cfg.larkCliPath, timeoutMs: Math.max(cfg.timeoutMs, CHAT_INDEX_TIMEOUT_MS) },
      )
      const unwrapped = unwrap(res)
      if (unwrapped.ok) {
        const chats = Array.isArray(unwrapped.data?.chats) ? unwrapped.data.chats : []
        value = chats.filter((chat) => chat && chat.chat_id && String(chat.name || '').trim())
        ttl = CHAT_INDEX_TTL_MS
      }
    } catch {
      /* 失败：短 TTL，下次搜索重试 */
    }
    chatIndexState = { at: Date.now(), ttl, value }
    chatIndexInflight = null
    return value
  })()
  return chatIndexInflight
}

/**
 * 取会话索引：缓存有效直接返回；过期但已有数据时**先返回旧值、后台刷新**
 * （避免每 10 分钟出现一次 3–4s 冷等待）；没有数据则同步拉取。
 */
async function ensureChatIndex(cfg) {
  const now = Date.now()
  const fresh = chatIndexState.at && now - chatIndexState.at < chatIndexState.ttl
  if (fresh) return chatIndexState.value
  if (chatIndexState.value.length) {
    void refreshChatIndex(cfg).catch(() => {})
    return chatIndexState.value
  }
  return refreshChatIndex(cfg)
}

/**
 * 按关键字搜索群聊与私聊：服务端群聊搜索（能按群成员名召回）+ 本地会话索引
 * （覆盖私聊，且按活跃度优先）。结果按「群聊 / 私聊」分开各取 limit 条。
 */
async function searchChats(q, limit, cfg) {
  const pageSize = String(Math.min(Math.max(limit, 1), 30))
  const [server, indexChats] = await Promise.all([
    runLark(['im', '+chat-search', '--query', q, '--as', cfg.identity, '--format', 'json', '--page-size', pageSize], {
      bin: cfg.larkCliPath,
      timeoutMs: cfg.timeoutMs,
    }),
    ensureChatIndex(cfg),
  ])

  const lower = q.toLowerCase()
  const startsWith = []
  const contains = []
  for (const chat of indexChats) {
    const name = String(chat.name || '').trim()
    if (!name) continue
    const hay = name.toLowerCase()
    if (!hay.includes(lower)) continue
    ;(hay.startsWith(lower) ? startsWith : contains).push(chat)
  }
  const localItems = [...startsWith, ...contains].map(mapChat).filter(Boolean)

  const unwrapped = unwrap(server)
  const serverItems = unwrapped.ok
    ? (Array.isArray(unwrapped.data?.chats) ? unwrapped.data.chats : []).map(mapChat).filter(Boolean)
    : []

  const seen = new Set()
  const merged = []
  for (const item of [...localItems, ...serverItems]) {
    if (!item.id || seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  const chats = merged.filter((item) => item.type === 'chat').slice(0, limit)
  const p2p = merged.filter((item) => item.type === 'p2p').slice(0, limit)
  if (merged.length === 0 && !unwrapped.ok) return { items: [], issue: unwrapped.issue }
  return { items: [...chats, ...p2p] }
}

/**
 * 最近会话（`@` 刚敲出来、q 为空时用）：群聊 + 私聊混排，按 active_time 倒序。
 * `--types p2p,group` 需要 user 身份；私聊的名称就是对方名称（或机器人名称）。
 */
async function recentChats(limit, cfg) {
  const res = await runLark(
    ['im', '+chat-list', '--types', 'p2p,group', '--sort', 'active_time', '--page-size', String(Math.min(Math.max(limit, 1), 50)), '--as', cfg.identity, '--format', 'json'],
    { bin: cfg.larkCliPath, timeoutMs: cfg.timeoutMs },
  )
  const unwrapped = unwrap(res)
  if (!unwrapped.ok) return { items: [], issue: unwrapped.issue }
  const data = unwrapped.data
  const chats = Array.isArray(data?.chats) ? data.chats : Array.isArray(data?.items) ? data.items : []
  const items = chats
    .map(mapChat)
    .filter(Boolean)
    .map((item) => ({ ...item, section: '最近会话' }))
    .slice(0, limit)
  return { items }
}

/**
 * 部门候选。部门名需要 `contact:department.base:readonly`：
 * 先探测一次，无权限就整片按 id 降级，避免每次搜索都打 N 条 detail 请求。
 */
async function searchDepartments(q, limit, cfg, state) {
  const res = await runLark(
    ['api', 'POST', '/open-apis/contact/v3/departments/search', '--data', JSON.stringify({ query: q, page_size: Math.min(Math.max(limit, 1), 50) })],
    { bin: cfg.larkCliPath, timeoutMs: cfg.timeoutMs },
  )
  const unwrapped = unwrap(res)
  if (!unwrapped.ok) return { items: [], issue: unwrapped.issue }
  const raw = Array.isArray(unwrapped.data?.items) ? unwrapped.data.items : []
  const rows = raw
    .map((row) => ({
      id: String(row.open_department_id || ''),
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null,
      memberCount: Number.isFinite(row.member_count) ? row.member_count : undefined,
    }))
    .filter((row) => row.id)
    .slice(0, limit)
  if (rows.length === 0) return { items: [] }

  const issues = []
  const allNamed = rows.every((row) => row.name !== null)
  let namesAvailable = state.deptNames.value
  if (allNamed) {
    // 授权后搜索接口直接带 name：一次调用即可，省掉逐条 detail。
    namesAvailable = true
    state.deptNames.value = true
    state.deptNames.at = Date.now()
  } else if (namesAvailable === undefined) {
    namesAvailable = await probeDepartmentNames(rows[0].id, cfg)
    state.deptNames.value = namesAvailable
    state.deptNames.at = Date.now()
  }
  if (namesAvailable === false) issues.push(deptScopeIssue())

  /** 部门行描述：成员数（有则带）+ ID。 */
  const describe = (row) => {
    const parts = []
    if (typeof row.memberCount === 'number') parts.push(`${row.memberCount} 人`)
    parts.push(`open_department_id ${row.id}`)
    return parts.join(' · ')
  }

  const items = []
  for (const row of rows) {
    let name = row.name
    if (!name && namesAvailable) name = await fetchDepartmentName(row.id, cfg)
    items.push({
      type: 'dept',
      name: name || row.id,
      id: row.id,
      idType: 'open_department_id',
      description: name ? describe(row) : `open_department_id ${row.id}（名称需授权）`,
      ...(name ? {} : { nameAuthorized: false }),
    })
  }
  return { items, issues }
}

/** 探测部门详情里是否带 name（一次调用即可确定整片权限）。 */
async function probeDepartmentNames(id, cfg) {
  return (await fetchDepartmentName(id, cfg)) !== null
}

/** 取单个部门名称；无权限/失败返回 null。 */
async function fetchDepartmentName(id, cfg) {
  const res = await runLark(
    ['api', 'GET', `/open-apis/contact/v3/departments/${id}`, '--params', JSON.stringify({ department_id_type: 'open_department_id' })],
    { bin: cfg.larkCliPath, timeoutMs: cfg.timeoutMs },
  )
  const unwrapped = unwrap(res)
  if (!unwrapped.ok) return null
  const departmentName = unwrapped.data?.department?.name
  return typeof departmentName === 'string' && departmentName.trim() ? departmentName.trim() : null
}

// ───────────────────────────── 对外检索 / 状态 ─────────────────────────────

/** 每进程一份缓存与部门权限结论。 */
const searchCache = new TimedCache()
const statusCache = new TimedCache()
const state = { deptNames: { value: undefined, at: 0 }, lastIssues: null }
/** 会话全量索引（群聊 + 私聊）缓存：{ at, ttl, value: rawChats[] }。 */
let chatIndexState = { at: 0, ttl: 0, value: [] }
let chatIndexInflight = null
/** 最近请求观察（调试：确认浏览器半是否真的在调本插件路由），最多 20 条。 */
const requestLog = []

/** 记录一条请求（防观测日志无限增长）。 */
function recordRequest(req, extra) {
  try {
    const headers = req && req.headers ? req.headers : {}
    requestLog.push({
      at: Date.now(),
      ...extra,
      ua: String(headers['user-agent'] || '').slice(0, 120),
      referer: String(headers.referer || '').slice(0, 120),
    })
    while (requestLog.length > 20) requestLog.shift()
  } catch {
    /* 观测失败不影响主流程 */
  }
}

/** 部门名结论过期后重新探测。 */
function deptNamesValue() {
  if (state.deptNames.value === undefined) return null
  if (Date.now() - state.deptNames.at > DEPT_NAMES_TTL_MS) return null
  return state.deptNames.value
}

/**
 * 搜索入口（路由与测试共用；永不 reject）。
 * 除候选外还带 `issues`：其他用户缺 lark-cli / 未登录 / 缺 scope 时，
 * client 会把它渲染成菜单里的提示行（选中无动作）。
 * @param {{q?: string, types?: string, limit?: number}} params
 * @param {object} cfg - normalizeConfig 的结果
 * @returns {Promise<{ok: true, q: string, items: any[], issues: object[], warnings: string[], recent?: boolean}>}
 */
export async function searchFeishu(params, cfg) {
  const q = String(params.q || '').trim().slice(0, MAX_QUERY_LENGTH)
  const limit = Number.isFinite(params.limit) ? Math.min(Math.max(Math.trunc(params.limit), 1), MAX_LIMIT) : 8
  const requestedTypes = String(params.types || 'user,chat,dept')
    .split(',')
    .map((type) => type.trim())
    .filter((type) => TYPES.has(type))
  const types = requestedTypes.length ? requestedTypes : ['user', 'chat', 'dept']

  if (!q) {
    try {
      return await searchCache.get(`recent|${limit}`, RECENT_CACHE_TTL_MS, async () => {
        const recent = await recentChats(limit, cfg)
        const issues = dedupeIssues([recent.issue])
        rememberIssues(issues)
        return { ok: true, q: '', recent: true, items: recent.items || [], issues, warnings: issuesToWarnings(issues) }
      })
    } catch (error) {
      return { ok: true, q: '', recent: true, items: [], issues: [], warnings: [String(error?.message || error)] }
    }
  }

  const key = `search|${q}|${types.join(',')}|${limit}`
  try {
    return await searchCache.get(key, cfg.cacheTtlMs, async () => {
      const jobs = []
      if (types.includes('user')) jobs.push(searchUsers(q, limit, cfg))
      if (types.includes('chat')) jobs.push(searchChats(q, limit, cfg))
      if (types.includes('dept')) jobs.push(searchDepartments(q, limit, cfg, state))
      const settled = await Promise.allSettled(jobs)
      const items = []
      const issues = []
      for (const result of settled) {
        if (result.status === 'rejected') {
          issues.push(makeIssue('search-failed', '飞书搜索失败', String(result.reason?.message || result.reason), ''))
          continue
        }
        items.push(...(result.value.items || []))
        issues.push(...(result.value.issues || []))
        if (result.value.issue) issues.push(result.value.issue)
      }
      // 默认顺序：部门 > 群聊/私聊 > 人（部门最容易被同名用户挤掉，放最前）
      const order = { dept: 0, chat: 1, p2p: 2, user: 3 }
      items.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))
      const deduped = dedupeIssues(issues)
      rememberIssues(deduped)
      return { ok: true, q, items, issues: deduped, warnings: issuesToWarnings(deduped) }
    })
  } catch (error) {
    return { ok: true, q, items: [], issues: [], warnings: [String(error?.message || error)] }
  }
}

/** issue → 纯文本（保留旧字段，方便日志/curl 观察）。 */
function issuesToWarnings(issues) {
  return dedupeIssues(issues).map((issue) => `${issue.title}${issue.fix ? `：${issue.fix}` : issue.detail ? `：${issue.detail}` : ''}`)
}

/** 记住最近一次搜索发现的 issue（status 路由展示用，便于 curl 自查）。 */
function rememberIssues(issues) {
  state.lastIssues = { at: Date.now(), issues: dedupeIssues(issues) }
}

/**
 * 插件状态（路由与测试共用；永不 reject）。
 * 供 README 排障与 curl 自查：是否找到 lark-cli、user 身份是否就绪、
 * 最近一次搜索发现的问题、以及可直接执行的修复命令。
 * @param {object} cfg
 * @returns {Promise<object>}
 */
export async function feishuStatus(cfg) {
  try {
    return await statusCache.get('status', STATUS_CACHE_TTL_MS, async () => {
      const lark = resolveLarkCli(cfg.larkCliPath)
      const result = await runLark(['auth', 'status'], { bin: cfg.larkCliPath, timeoutMs: cfg.timeoutMs })
      const issues = []
      let auth = { ready: false, identity: null, userName: null, openId: null, expiresAt: null, tokenStatus: null }
      const json = result.ok && result.json && typeof result.json === 'object' ? result.json : null
      if (json) {
        const user = json.identities && json.identities.user
        auth = {
          ready: user?.status === 'ready',
          identity: json.identity ?? null,
          userName: user?.userName ?? null,
          openId: user?.openId ?? null,
          expiresAt: user?.expiresAt ?? null,
          tokenStatus: user?.tokenStatus ?? null,
        }
        if (!auth.ready) {
          issues.push(makeIssue('auth-required', '飞书未登录', user?.message || 'lark-cli 的用户身份不可用', LARK_LOGIN_FIX))
        }
      } else {
        issues.push(classifyLarkError(result.error, result.json, { missing: !lark.found }))
      }
      const departmentNames = deptNamesValue()
      if (departmentNames === false) issues.push(deptScopeIssue())
      const recent = state.lastIssues && Date.now() - state.lastIssues.at < 5 * 60_000 ? state.lastIssues.issues : []
      const merged = dedupeIssues([...issues, ...recent])
      return {
        ok: true,
        cli: { found: lark.found, bin: lark.found ? lark.bin : null },
        auth,
        departmentNames,
        issues: merged,
        warnings: issuesToWarnings(merged),
      }
    })
  } catch (error) {
    return {
      ok: true,
      cli: { found: false, bin: null },
      auth: { ready: false, identity: null, userName: null, openId: null, expiresAt: null, tokenStatus: null },
      departmentNames: null,
      issues: [],
      warnings: [String(error?.message || error)],
    }
  }
}

// ───────────────────────────── HTTP 路由 ─────────────────────────────

/** 写 JSON 响应。 */
function jsonResponse(res, body, code = 200) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 绑定注册动作到当前 fiber（宿主卸载/热替换时自动释放）。 */
function bindLifecycle(ctx, register) {
  return typeof ctx.effect === 'function' ? ctx.effect(register) : register()
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const webServer = ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (!webServer || typeof webServer.register !== 'function') return

  const handlers = {
    [ROUTES.search]: async (req, res) => {
      let params = {}
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        params = {
          q: url.searchParams.get('q') || '',
          types: url.searchParams.get('types') || undefined,
          limit: Number(url.searchParams.get('limit') || '') || undefined,
        }
      } catch {
        /* 解析失败按空查询处理 */
      }
      recordRequest(req, { path: 'search', q: String(params.q || '').slice(0, 50) })
      const payload = await searchFeishu(params, cfg)
      jsonResponse(res, payload)
    },
    [ROUTES.status]: async (_req, res) => {
      recordRequest(_req, { path: 'status' })
      const payload = await feishuStatus(cfg)
      jsonResponse(res, { ...payload, lastRequests: requestLog.slice(-20) })
    },
  }

  // 后台预热「群聊 + 私聊」会话索引（首次约 3–4s），让第一次模糊搜索就能出私聊。
  void ensureChatIndex(cfg).catch(() => {})

  bindLifecycle(ctx, () => {
    const disposers = []
    for (const [path, handler] of Object.entries(handlers)) {
      const wrapped = (req, res) => {
        Promise.resolve(handler(req, res)).catch((error) => {
          try {
            jsonResponse(res, { ok: true, items: [], warnings: [String(error?.message || error)] })
          } catch {
            /* 响应已结束 */
          }
        })
      }
      disposers.push(webServer.register({ kind: 'exact', path, handler: wrapped }))
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已释放 */
        }
      }
    }
  })
}

export default { name, inject, apply }
