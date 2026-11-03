# dsh-feishu-at 内部实现契约（Lead 维护，两半共同遵守）

目标：DSH Web GUI 输入框里敲 `@` → 出现飞书候选菜单（用户 / 群聊 / 部门），按 `@` 后字符模糊搜索；
选中后插入一个原子 @ 块（默认显示名称）；发送给模型时该块被序列化成带「名称 + ID + ID 类型」的文本。

- 包名：`@sidleo3/dsh-feishu-at`；Host 半 `index.js`，Client 半 `client.js`（均为 plain ESM/JS，无构建步骤、无 npm 依赖）。
- Host 半负责：调 `lark-cli` 搜索 + 缓存 + 暴露 `/api/dsh-feishu-at/*` HTTP 路由。
- Client 半负责：往 `ctx.inputTriggers` 注册 `@` 来源，用同源 fetch 调 Host 路由，把结果映射成候选，插入引用块。
- 两半之间只通过下列 HTTP 契约耦合；不要互相 import。

## 0. DSH 0.2.1-rc.5 事实（已核实，别猜）

- 输入触发流水线服务：`ctx.inputTriggers.registerSource(source)`，source 形状见
  `<全局 npm 前缀>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/types/types.d.ts`
  （`trigger:'@'`、`name`、`order`、`showGroupTitle`、`candidates(session, req)`、`onPick(pick)`、`codec`、`openReference?`）。
- `candidates` 返回 `InputTriggerCandidate[]`：`{ name, label?, description?, icon?, section?, value? }`。
  `icon` 可以是 React 组件，菜单以 `<Icon size={14} />` 渲染；`section` 相同的相邻行共享一个小标题；
  只要本组有任意行带 `section`，本组的分组标题就不渲染（所以 `showGroupTitle: false` + section 最干净）。
- `onPick` 返回 `{ insert: ReferenceInsert }`；`ReferenceInsert = { source, ref, label, clipboardText, appearance? }`，
  `appearance` 必须是 `'session'|'file'|'folder'` 或省略 —— **必须省略**，省略时输入框块显示 `@` 前缀 + label（正好是 @ 块）。
  `source` 必须等于注册的 source `name`（提交时按它路由 codec）。
- 提交时对每个引用块调用 `codec.serialize(ref, signal)`，返回值替换块文本；
  `codec.clipboardText(ref)` 是剪贴板/草稿持久化投影（显示用）。
- Client 半格式照抄参考插件：`<全局 npm 前缀>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-reference/lib/client.js`。
  浏览器插件 bundle 是 `window.__ModuleLoader__.load({ id, factory(require){ ...; return module.exports } })`，
  模块里 `require("react")`（baseline 模块表提供），导出 `apply(ctx)` 和 `inject`（cordis 服务名数组）。
- `client.js` 里 fetch 路由必须用**文档相对路径**（无前导 `/`）：`api/dsh-feishu-at/search?...`
  （GUI 带 `<base href="./">`，根绝对 `/api` 在子路径部署会 404；见 skill-explorer 的注释）。
- Host 半格式照抄：`~/.dsh/profiles/desktop/node_modules/@linxin666/dsh-client-ui-skill-explorer/lib/index.js`
  末尾（`const name`、`const inject = ['webServer']`、`function apply(ctx, config)`、`ctx.effect(() => ctx.webServer.register(route))`、`export { apply, inject, name }`）。
  路由对象：`{ kind: 'exact', path: '/api/dsh-feishu-at/search', handler: async (req, res) => {} }`。
- lark-cli 落点/PATH 解析照抄：`~/.dsh/profiles/desktop/node_modules/@sidleo3/dsh-wiki/vendor-core/lib/feishu.mjs` 的
  `resolveLarkCli` / `runLark` / `unwrap`（GUI 进程 PATH 里通常没有 `~/.local/bin`，必须回退候选路径并补子进程 PATH）。
  路由/JSON 响应/body 读取照抄：`~/.dsh/profiles/desktop/node_modules/@sidleo3/dsh-wiki/wiki.mjs` 里
  `bindLifecycle` / `jsonResponse` / `readJsonBody`（行号约 177-193、259-290）。

## 1. Host HTTP 契约（index.js）

### GET `/api/dsh-feishu-at/search?q=<query>&types=user,chat,dept&limit=<n>`

- `q`：`@` 之后的字符（可为空）；trim；截断到 50 字符（飞书用户搜索上限）。
- `types`：逗号分隔，缺省 `user,chat,dept`；`limit`：每类条数，默认 8，1..20。
- 响应 200 JSON：
  ```json
  {
    "ok": true,
    "q": "张志",
    "items": [
      {
        "type": "user",
        "name": "张三",
        "id": "ou_xxxx...",
        "idType": "open_id",
        "description": "某小组 · open_id ou_xxxx...",
        "department": "某集团-某中心-某部门-某小组-分部"
      },
      { "type": "chat", "name": "项目协作群", "id": "oc_xxxx...", "idType": "chat_id", "description": "chat_id oc_xxxx..." },
      { "type": "dept", "name": "某部门", "id": "od-xxxx...", "idType": "open_department_id", "description": "open_department_id od-xxxx..." }
    ],
    "issues": [],
    "warnings": []
  }
  ```
  顺序：user → chat → dept。失败也要 200 + `ok:true` + 空 items + `issues`（不弹错误 UI、不 500）。
- `q` 为空（一敲 `@` 就出菜单）：返回**最近会话**（群聊 + 私聊混排，按最近活跃倒序）：
  `lark-cli im +chat-list --types p2p,group --sort active_time --page-size <limit> --as user --format json`。
  `chat_mode === 'p2p'` 的行 type=`p2p`（description 前缀「私聊 ·」/「机器人私聊 ·」），其余 type=`chat`；
  section 统一用「最近会话」。不要返回部门/用户。
- user 行 description：`<部门末段或末两段> · open_id <id>`；无部门时 `open_id <id>`。
- chat 行 description：`chat_id <id>`（有 description 字段时可在前面加 `群描述 · `）。
- dept 行 description：`open_department_id <id>`；名称拿不到时 `name` 用 id 本身，description 后缀加「（名称需授权）」，并在 `issues` 里带一条 `kind: 'dept-names'`。
- 过滤：跳过 name 为空的用户/群（群 p2p 无名）。`is_cross_tenant: true` 的用户照收，name 后不加标记（description 里已带 id）。

### GET `/api/dsh-feishu-at/status`

```json
{ "ok": true, "cli": { "found": true, "bin": "~/.local/bin/lark-cli" },
  "auth": { "ready": true, "identity": "user", "userName": "张三", "openId": "ou_...",
            "expiresAt": "2026-11-03T20:56:40+08:00", "tokenStatus": "valid" },
  "departmentNames": false,
  "issues": [ { "kind": "dept-names", "title": "部门名称无权限", "detail": "...", "fix": "lark-cli auth login --scope contact:department.base:readonly", "scopes": ["contact:department.base:readonly"] } ],
  "warnings": ["部门名称无权限：lark-cli auth login --scope contact:department.base:readonly"] }
```
`lark-cli auth status` 输出**裸 JSON**（没有 `{ok,data}` 信封，也不需要 `--format`）：顶层 `identities.user.status === 'ready'` 即 ready。
`found:false` 时其余字段允许为 null/空数组，不抛 500。`issues` 里额外合并最近 5 分钟搜索发现的问题，方便一条 curl 自查。

### issues 契约（缺授权的可见通道）

两个路由都返回 200，失败一律表达为 `issues[]`，每条：
`{ kind, title, detail, fix, scopes? }`。

| kind | 触发 | fix（给用户照抄的命令） |
|---|---|---|
| `cli-missing` | 本机找不到 lark-cli | `npm i -g @larksuite/cli && lark-cli config init && lark-cli auth login` |
| `not-configured` | lark-cli 没配 app-id/app-secret | `lark-cli config init`（再 `lark-cli auth login`） |
| `auth-required` | 未登录 / user token 过期 / 无 user 身份 | `lark-cli auth login` |
| `scope-missing` | lark-cli 报 `error.subtype === 'missing_scope'` | `lark-cli auth login --scope "<missing_scopes 空格拼接>"`，并把 `scopes` 原样带出 |
| `dept-names` | 部门名探测失败 | `lark-cli auth login --scope contact:department.base:readonly` |
| `search-failed` | 其它失败 | 空串（只展示 detail） |

规则：`kind` 决定分类，`title` 是菜单提示行标题，`fix` 是可直接执行的命令；同 `kind+fix` 去重。
分类依据是 lark-cli 的错误信封（`error.type/subtype/message/missing_scopes`）与输出文本，不要硬编码 scope 清单。

### lark-cli 调用（全部 `--as user`，输出都是 JSON 信封 `{ ok, data }`）

1. 用户：`lark-cli contact +search-user --query <q> --as user --format json --page-size <limit>`
   → `data.users[]`：`open_id, localized_name, department, email, is_cross_tenant, has_chatted, p2p_chat_id`。
2. 群聊：`lark-cli im +chat-search --query <q> --as user --format json --page-size <limit>`
   → `data.chats[]`：`chat_id, name, chat_mode, external, description`。
3. 部门搜索：`lark-cli api POST /open-apis/contact/v3/departments/search --data '{"query":"<q>","page_size":<limit>}'`
   → `data.items[]` 只有 `open_department_id`。
   部门名（两种来源，优先前者）：
   a) 授权了 `contact:department.base:readonly` 后，**搜索接口本身**就回 `name` / `member_count` —— 直接用，不要逐条 detail；
   b) 未授权时搜索接口只有 `open_department_id`：探测一次 `lark-cli api GET /open-apis/contact/v3/departments/<od-id>
      --params '{"department_id_type":"open_department_id"}'` 的 `data.department.name`，缺 name 则缓存 `departmentNames=false`，
      整片按 id 降级（description 带「名称需授权」+ warnings 给授权命令）。
   注意：`lark-cli auth login --domain contact` 不含部门读权限，必须用
   `lark-cli auth login --scope contact:department.base:readonly`。
4. 最近会话：`lark-cli im +chat-list --types p2p,group --sort active_time --page-size <limit> --as user --format json`
   → `data.chats[]`（含 `chat_mode: 'group' | 'p2p'`、`p2p_target_type: 'user' | 'bot'`；私聊 name 是对方/机器人名称）。
- 超时：单条命令 8s（`execFile` 的 `timeout`），`maxBuffer` 32MB，`shell:false`；
- 结果信封：`res.json.ok === false` → 视为该来源失败，交给 `classifyLarkError` 归成 issue。注意 lark-cli
  **API 失败时退出码仍是 0**，必须看输出里的 `{ok:false,error:{...}}`；`error.subtype='missing_scope'` 时带
  `missing_scopes` 数组（例：`{"error":{"type":"authorization","subtype":"missing_scope","code":99991679,"missing_scopes":["hire:job:readonly"]}}`）。
- 缓存：内存 Map，key=`类型|q|limit`，TTL 120s（`auth status` 30s，最近会话 60s），最多 200 条；
  并发去重（同 key 进行中复用同一 Promise）。
- 全部来源 `Promise.allSettled` 并行；单来源失败不影响其它来源。

### 配置（apply 的第二参 config，patch 里默认 `{}`）

`{ larkCliPath?: string, identity?: 'user', timeoutMs?: number, cacheTtlMs?: number }`，全部可选、有缺省；
不要写 `package.json` 之外的配置校验（不导出 Config）。`inject = ['webServer']`，`webServer` 不存在时 apply 直接 return。
所有导出：`export { name, inject, apply }`（`name = 'feishu-at'`）。

## 2. Client 契约（client.js）

- 模块格式（照抄 decoration 模板，但 id 用包名）：
  ```js
  window.__ModuleLoader__.load({ id: '@sidleo3/dsh-feishu-at', factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ...icons + source...
    return { inject: ['inputTriggers'], apply(ctx) { ... } };
  }});
  ```
- `apply(ctx)`：`ctx.effect(() => ctx.get('inputTriggers').registerSource(source), 'feishu-at: @ source')`。
- source：
  - `trigger:'@'`，`name:'feishu'`，`order:-10`，`showGroupTitle:false`；
  - `async candidates(session, { query, quoted, signal })`：
    - `quoted === true`（`@"...` 文件路径 token）→ `return []`；
    - 120ms 去抖（用 AbortSignal 感知取消，aborted 就 reject/return []）+ 60s 内存缓存 + 并发去重；
    - `fetch('api/dsh-feishu-at/search?q=' + encodeURIComponent(query))`（无前导 `/`；`{ signal }`）；
    - 网络失败/非 404 → 返回 [] 并 `console.warn` 一次（不要抛，组静默消失）；
    - HTTP 404（Host 半没加载）→ 返回一条提示行 `飞书 @ 提及未就绪`（section `飞书授权 / 配置`）；
    - 响应带 `issues[]` → 在真实候选后追加最多 2 条提示行：`{ name: issue.title, label: issue.title,
      description: issue.fix || issue.detail, icon: WarningIcon, section: '飞书授权 / 配置', value: 'hint:' + issue.kind }`；
    - 映射：`{ name: item.name, label: item.name, description: item.description,
      icon: ICONS[item.type], section: SECTION[item.type], value: JSON.stringify({ t:item.type, id:item.id, n:item.name, idType:item.idType }) }`
      section：`user→'飞书用户'`、`chat→'飞书群聊'`、`p2p→'飞书私聊'`、`dept→'飞书部门'`（item 自带 section 时优先，最近会话用「最近会话」）。
  - `onPick({ candidate })`：`candidate.value` 以 `hint:` 开头 → 返回 `'handled'`（提示行只做展示，**不插入内容**）；
      否则解析 `candidate.value` → `{ insert: { source:'feishu', ref: JSON.stringify(p), label: p.n,
      clipboardText: '@' + p.n } }`（**不要给 appearance**；块的显示 = `@` + 名称）。
  - `codec`：
    - `clipboardText(ref)` → `'@' + parse(ref).n`
    - `serialize(ref, signal)` → 用户：`` `@${n}（飞书用户，open_id=${id}）` ``；
      群聊：`` `@${n}（飞书群聊，chat_id=${id}）` ``；部门：`` `@${n}（飞书部门，open_department_id=${id}）` ``。
  - `openReference()` → `return false`（点击块不预览）。
- 搜索结果顺序固定「部门 > 群聊/私聊 > 人」，Client 侧每类最多 `MAX_PER_TYPE = 5` 行、总计 `MAX_ITEMS = 20`；最近会话（`body.recent === true`）保持 Host 顺序、不按类截断。
- 三个 icon：函数组件 `function Icon({ size })` 返回 14×14 的 inline svg，`fill="currentColor"`（用户=人形、群聊=对话气泡、部门=组织树/楼）。
- 候选行 `name` 必须非空字符串；`value` 是唯一的取数通道（不要放闭包状态）。
- 服务名用 `ctx.get('inputTriggers')`；`inject: ['inputTriggers']` 让 apply 等 service 就绪。

## 3. 联调与验收（Lead 负责，开发者自查）

- 写完后 `node --check index.js` / `node --check client.js`（client.js 顶层是浏览器 API 也照样能过语法检查）。
- 测试：`node --test "test/*.test.mjs"`（Host 用假 lark-cli 桩覆盖缺 CLI / 未登录 / 缺 scope / 部门无权限；Client 用假 ModuleLoader + fetch 覆盖提示行渲染与选中无动作）。
- Host 半可在 /tmp 写临时脚本 `node -e` 直接调本文件导出的私有函数（如果导出）或用 `curl` 在装好后验证：
  `curl -s 'http://127.0.0.1:<DSH Web 端口>/api/dsh-feishu-at/search?q=%E5%BC%A0'`。
- 浏览器验收由 Lead 用 GUI 完成（敲 `@`、模糊搜索、选中、发送，看串）。
- 别改 `package.json` / `cordis.patch.yml` / `locale/` / `icon.svg`（Lead 所有）。
