/**
 * dsh-feishu-at Client 半测试：在 Node 里用假的 ModuleLoader / React / fetch 加载
 * client.js，验证「缺授权」时菜单提示行的渲染与选中行为。
 *
 * 运行：node --test test/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const REACT_STUB = { createElement: () => null }

/**
 * 加载一份全新的 client.js（query 参数绕开 ESM 缓存），返回 @ 来源对象。
 * @param {typeof fetch} fetchImpl - 假 fetch
 * @returns {Promise<object>} source
 */
async function loadSource(fetchImpl) {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(options) {
        captured = options
      },
    },
  }
  globalThis.fetch = fetchImpl
  await import(`../client.js?case=${Math.random()}`)
  assert.ok(captured, 'client.js 应调用 __ModuleLoader__.load')
  const mod = captured.factory((id) => (id === 'react' ? REACT_STUB : undefined))
  let source = null
  const ctx = {
    inputTriggers: { registerSource: (registered) => { source = registered } },
    effect: (fn) => { fn(); return () => {} },
    get: () => undefined,
  }
  mod.apply(ctx)
  assert.ok(source, 'apply 应注册 @ 来源')
  return source
}

/** 构造 fetch 响应。 */
function jsonResponse(body, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
}

/** 构造 candidates 请求参数。 */
const request = (query = '') => ({ query, quoted: false, signal: new AbortController().signal })

const SEARCH_BODY = {
  ok: true,
  q: '张',
  items: [
    { type: 'user', name: '张三', id: 'ou_a', idType: 'open_id', description: '测试部门 · open_id ou_a' },
  ],
  issues: [
    {
      kind: 'scope-missing',
      title: '飞书授权缺少 scope',
      detail: '缺少：contact:user.base:readonly',
      fix: 'lark-cli auth login --scope "contact:user.base:readonly"',
      scopes: ['contact:user.base:readonly'],
    },
  ],
  warnings: [],
}

test('搜索成功但缺 scope：候选后追加提示行，且提示行选中无动作', async () => {
  const source = await loadSource(jsonResponse(SEARCH_BODY))
  const rows = await source.candidates(null, request('张'))
  const normal = rows.filter((row) => row.section !== '飞书授权 / 配置')
  const hints = rows.filter((row) => row.section === '飞书授权 / 配置')
  assert.equal(normal.length, 1)
  assert.equal(normal[0].name, '张三')
  assert.equal(hints.length, 1)
  assert.equal(hints[0].label, '飞书授权缺少 scope')
  assert.match(hints[0].description, /lark-cli auth login --scope/)
  assert.equal(source.onPick({ candidate: hints[0] }), 'handled')
})

test('只有授权问题（无候选）：提示行仍可见', async () => {
  const body = { ok: true, q: '', recent: true, items: [], issues: [SEARCH_BODY.issues[0]], warnings: [] }
  const source = await loadSource(jsonResponse(body))
  const rows = await source.candidates(null, request(''))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].section, '飞书授权 / 配置')
})

test('真实候选仍然插入引用块', async () => {
  const body = { ok: true, q: '张', items: SEARCH_BODY.items, issues: [], warnings: [] }
  const source = await loadSource(jsonResponse(body))
  const rows = await source.candidates(null, request('张'))
  const pick = source.onPick({ candidate: rows[0] })
  assert.ok(pick && pick.insert, '应返回 insert 结果')
  assert.equal(pick.insert.source, 'feishu')
  assert.match(pick.insert.ref, /ou_a/)
})

test('Host 路由 404（插件未加载）：给一条未就绪提示，且不抛错', async () => {
  const source = await loadSource(jsonResponse({}, 404))
  const rows = await source.candidates(null, request(''))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, '飞书 @ 提及未就绪')
  assert.equal(source.onPick({ candidate: rows[0] }), 'handled')
})

test('网络错误（非 404）：保持静默，不干扰其它候选组', async () => {
  const source = await loadSource(async () => {
    throw new TypeError('fetch failed')
  })
  const rows = await source.candidates(null, request(''))
  assert.deepEqual(rows, [])
})
