/**
 * dsh-feishu-at Host 半测试：用假 lark-cli（桩脚本）覆盖
 * 「其他用户安装时缺授权」的四类现场——缺 CLI / 未登录 / 缺 scope / 部门无权限。
 *
 * 运行：node --test test/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { searchFeishu, feishuStatus, resetForTests } from '../index.js'

/** 桩脚本里用到的 JSON 片段。 */
/** 真实 `lark-cli auth status` 输出是裸 JSON（无 ok/data 信封）。 */
const OK_AUTH = {
  appId: 'cli_test',
  identities: { user: { status: 'ready', userName: '测试用户', openId: 'ou_test', tokenStatus: 'valid', expiresAt: '2026-11-03T20:00:00+08:00' } },
  identity: 'user',
}
const AUTH_EXPIRED = {
  appId: 'cli_test',
  identities: {
    bot: { status: 'ready' },
    user: { status: 'expired', message: 'User identity: expired', tokenStatus: 'expired' },
  },
  identity: 'bot',
}
const NO_USER_IDENTITY = {
  appId: 'cli_test',
  identities: { bot: { status: 'ready' } },
  identity: 'bot',
}
const MISSING_SCOPE_ENVELOPE = {
  ok: false,
  error: {
    type: 'authorization',
    subtype: 'missing_scope',
    code: 99991679,
    message: 'unauthorized: user authorization does not cover the required scope(s): contact:user.base:readonly',
    missing_scopes: ['contact:user.base:readonly'],
  },
}
const AUTH_ERROR_ENVELOPE = {
  ok: false,
  error: { type: 'authentication', subtype: 'token_missing', code: 99991663, message: 'not logged in: run `lark-cli auth login` and retry' },
}
const USERS_OK = { ok: true, data: { users: [{ localized_name: '张三', open_id: 'ou_a', department: '测试部门-分部' }] } }
const CHATS_OK = { ok: true, data: { chats: [{ name: '测试群', chat_id: 'oc_a', description: '测试群' }] } }
const DEPTS_OK = { ok: true, data: { items: [{ open_department_id: 'od-1', name: '测试部门', member_count: 5 }] } }
/** 最近会话：群聊 + 私聊混排（chat-list --types p2p,group）。 */
const RECENT_OK = {
  ok: true,
  data: {
    chats: [
      { chat_id: 'oc_recent_group', name: '最近群', chat_mode: 'group', description: '' },
      { chat_id: 'oc_recent_p2p', name: '私聊对象', chat_mode: 'p2p', p2p_target_type: 'user' },
      { chat_id: 'oc_recent_bot', name: '某机器人', chat_mode: 'p2p', p2p_target_type: 'bot' },
    ],
  },
}
const DEPTS_NAMED_BY_DETAIL = { ok: true, data: { items: [{ open_department_id: 'od-1', member_count: 5 }] } }
const DEPT_DETAIL_DENIED = {
  ok: false,
  error: { type: 'authorization', subtype: 'missing_scope', code: 99991679, message: 'x', missing_scopes: ['contact:department.base:readonly'] },
}

/**
 * 生成假 lark-cli：按子命令输出 canned JSON。
 * @param {object} plan - { auth, users, chats, recent, depts, deptDetail }
 * @returns {Promise<string>} 可执行脚本绝对路径
 */
async function makeStub(plan) {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-at-stub-'))
  const file = join(dir, 'lark-cli.cjs')
  const body = `#!/usr/bin/env node
const plan = ${JSON.stringify(plan)}
const args = process.argv.slice(2)
const cmd = args.join(' ')
const out = cmd.startsWith('auth status') ? plan.auth
  : cmd.startsWith('contact +search-user') ? plan.users
  : cmd.startsWith('im +chat-search') ? plan.chats
  : cmd.startsWith('im +chat-list') ? plan.recent
  : cmd.startsWith('api POST /open-apis/contact/v3/departments/search') ? plan.depts
  : cmd.startsWith('api GET /open-apis/contact/v3/departments/') ? plan.deptDetail
  : { ok: false, error: { type: 'validation', subtype: 'unknown_command', message: 'stub: unknown ' + cmd } }
process.stdout.write(JSON.stringify(out))
`
  await writeFile(file, body)
  await chmod(file, 0o755)
  return file
}

/** 构造插件 config。 */
const cfgFor = (bin) => ({ larkCliPath: bin, timeoutMs: 4000, cacheTtlMs: 0, identity: 'user' })

test('全部授权正常：候选齐全且无 issue', async () => {
  resetForTests()
  const bin = await makeStub({ auth: OK_AUTH, users: USERS_OK, chats: CHATS_OK, recent: RECENT_OK, depts: DEPTS_OK, deptDetail: DEPT_DETAIL_DENIED })
  const cfg = cfgFor(bin)
  const result = await searchFeishu({ q: '张', limit: 8 }, cfg)
  assert.equal(result.ok, true)
  assert.ok(result.items.length >= 2, '应同时有用户与群聊候选')
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.warnings, [])
})

test('本机没有 lark-cli：给出安装 + 登录命令', async () => {
  resetForTests()
  const bin = await makeStub({ auth: OK_AUTH, users: USERS_OK, chats: CHATS_OK, recent: RECENT_OK, depts: DEPTS_OK, deptDetail: DEPT_DETAIL_DENIED })
  const cfg = cfgFor('/nonexistent/lark-cli')
  const result = await searchFeishu({ q: '张', limit: 8 }, cfg)
  assert.deepEqual(result.items, [])
  assert.equal(result.issues[0].kind, 'cli-missing')
  assert.match(result.issues[0].fix, /@larksuite\/cli/)
})

test('lark-cli 未登录：分类为 auth-required 并给登录命令', async () => {
  resetForTests()
  const bin = await makeStub({ auth: AUTH_EXPIRED, users: AUTH_ERROR_ENVELOPE, chats: AUTH_ERROR_ENVELOPE, recent: AUTH_ERROR_ENVELOPE, depts: AUTH_ERROR_ENVELOPE, deptDetail: AUTH_ERROR_ENVELOPE })
  const cfg = cfgFor(bin)
  const result = await searchFeishu({ q: '张', limit: 8 }, cfg)
  assert.deepEqual(result.items, [])
  assert.ok(result.issues.some((issue) => issue.kind === 'auth-required'), JSON.stringify(result.issues))
  const issue = result.issues.find((row) => row.kind === 'auth-required')
  assert.equal(issue.fix, 'lark-cli auth login')
})

test('缺 scope：issue 带出缺失 scope 与可执行的授权命令', async () => {
  resetForTests()
  const bin = await makeStub({ auth: OK_AUTH, users: MISSING_SCOPE_ENVELOPE, chats: CHATS_OK, recent: RECENT_OK, depts: DEPTS_OK, deptDetail: DEPT_DETAIL_DENIED })
  const cfg = cfgFor(bin)
  const result = await searchFeishu({ q: '张', limit: 8 }, cfg)
  const scopeIssue = result.issues.find((issue) => issue.kind === 'scope-missing')
  assert.ok(scopeIssue, JSON.stringify(result.issues))
  assert.deepEqual(scopeIssue.scopes, ['contact:user.base:readonly'])
  assert.equal(scopeIssue.fix, 'lark-cli auth login --scope "contact:user.base:readonly"')
  assert.ok(result.items.some((item) => item.type === 'chat'), '单个域缺权限不应影响其它域候选')
})

test('部门名称无权限：部门行降级为 ID，同时给出授权提示', async () => {
  resetForTests()
  const bin = await makeStub({ auth: OK_AUTH, users: USERS_OK, chats: CHATS_OK, recent: RECENT_OK, depts: DEPTS_NAMED_BY_DETAIL, deptDetail: DEPT_DETAIL_DENIED })
  const cfg = cfgFor(bin)
  const result = await searchFeishu({ q: '商品', limit: 8, types: 'dept' }, cfg)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].name, 'od-1')
  assert.ok(result.issues.some((issue) => issue.kind === 'dept-names'), JSON.stringify(result.issues))
})

test('status：已登录时 ready 且无 issue', async () => {
  resetForTests()
  const bin = await makeStub({ auth: OK_AUTH, users: USERS_OK, chats: CHATS_OK, recent: RECENT_OK, depts: DEPTS_OK, deptDetail: DEPT_DETAIL_DENIED })
  const status = await feishuStatus(cfgFor(bin))
  assert.equal(status.cli.found, true)
  assert.equal(status.auth.ready, true)
  assert.equal(status.auth.userName, '测试用户')
  assert.deepEqual(status.issues, [])
})

test('status：未登录时 ready=false 并带 auth-required', async () => {
  resetForTests()
  const bin = await makeStub({ auth: NO_USER_IDENTITY, users: AUTH_ERROR_ENVELOPE, chats: AUTH_ERROR_ENVELOPE, recent: AUTH_ERROR_ENVELOPE, depts: AUTH_ERROR_ENVELOPE, deptDetail: AUTH_ERROR_ENVELOPE })
  const status = await feishuStatus(cfgFor(bin))
  assert.equal(status.auth.ready, false)
  assert.ok(status.issues.some((issue) => issue.kind === 'auth-required'), JSON.stringify(status.issues))
})

test('status：CLI 不存在时 cli.found=false 并带 cli-missing', async () => {
  resetForTests()
  const status = await feishuStatus(cfgFor('/nonexistent/lark-cli'))
  assert.equal(status.cli.found, false)
  assert.ok(status.issues.some((issue) => issue.kind === 'cli-missing'), JSON.stringify(status.issues))
})

test('最近会话：群聊与私聊混排在同一节，私聊标出类型', async () => {
  resetForTests()
  const bin = await makeStub({ auth: OK_AUTH, users: USERS_OK, chats: CHATS_OK, recent: RECENT_OK, depts: DEPTS_OK, deptDetail: DEPT_DETAIL_DENIED })
  const result = await searchFeishu({ q: '', limit: 10 }, cfgFor(bin))
  assert.equal(result.recent, true)
  const types = result.items.map((item) => item.type)
  assert.deepEqual(types, ['chat', 'p2p', 'p2p'])
  assert.ok(result.items.every((item) => item.section === '最近会话'))
  const botItem = result.items.find((item) => item.id === 'oc_recent_bot')
  assert.equal(botItem.name, '某机器人')
  assert.match(botItem.description, /机器人私聊/)
  const userItem = result.items.find((item) => item.id === 'oc_recent_p2p')
  assert.match(userItem.description, /私聊/)
})

test('搜索排序：部门 > 群聊/私聊 > 人', async () => {
  resetForTests()
  const bin = await makeStub({
    auth: OK_AUTH,
    users: { ok: true, data: { users: [{ localized_name: '用户甲', open_id: 'ou_u1' }, { localized_name: '用户乙', open_id: 'ou_u2' }] } },
    chats: { ok: true, data: { chats: [{ name: '群甲', chat_id: 'oc_c1' }, { name: '群乙', chat_id: 'oc_c2' }] } },
    recent: RECENT_OK,
    depts: { ok: true, data: { items: [{ open_department_id: 'od-1', name: '部门甲', member_count: 3 }, { open_department_id: 'od-2', name: '部门乙', member_count: 2 }] } },
    deptDetail: DEPT_DETAIL_DENIED,
  })
  const result = await searchFeishu({ q: '甲', limit: 5 }, cfgFor(bin))
  assert.deepEqual(result.items.map((item) => item.type), ['dept', 'dept', 'chat', 'chat', 'user', 'user'])
})
