# dsh-feishu-at · 飞书 @ 提及

在 DSH Web GUI 的输入框里敲 `@`，直接模糊搜索并选择**飞书用户 / 群聊 / 部门**：

- `@` 后继续输入即按字符模糊搜索（服务端关键字搜索 + 菜单实时过滤）；
- 选中后插入一个原子 @ 块，**默认显示名称**（块不可拆字编辑，删一次删整块）；
- 发送给模型时，块被序列化为带 **名称 + ID + ID 类型** 的文本，例如：
  - `@张三（飞书用户，open_id=ou_xxxx…）`
  - `@项目协作群（飞书群聊，chat_id=oc_xxxx…）`
  - `@某部门（飞书部门，open_department_id=od-xxxx…）`
- 一敲 `@`（还没输入字符）时先展示**最近会话**（群聊 + 私聊混排，按最近活跃排序），回车即可选中；
- 输入字符搜索时**群聊与私聊一起搜**（私聊靠本地会话索引按名称匹配），结果按 **部门 > 群聊 > 私聊 > 人** 排列，每类最多显示 5 条，行尾显示 ID 类型 + ID。

## 前置条件

| 依赖 | 说明 |
|------|------|
| DSH `>= 0.2.1-rc.3` | 依赖内置的输入触发流水线（`dsh-client-ui-input-trigger`）与 `webServer` 路由 |
| `lark-cli`（本机 `~/.local/bin/lark-cli`） | 已用 **user 身份**登录：`lark-cli auth login`。插件会自动在 PATH 之外回退查找 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` |
| 部门名称（可选） | 部门名称要 `contact:department.base:readonly` 读权限（`--domain contact` 不含它）。未授权时部门行只显示 `open_department_id`，菜单里同时给出授权命令 |

## 安装

```bash
# 从 npm 装（推荐）
dsh plugin --profile desktop add @sidleo3/dsh-feishu-at

# 或从仓库装（开发用，link 到本地目录）
dsh plugin --profile desktop add link:/绝对路径/dsh-feishu-at
```

安装后重启 DSH 加载 Host 半，并刷新浏览器页面加载 Client 半。
若 profile 用显式 bundles 清单（`package.json` → `dsh.profile.bundles`），把 `@sidleo3/dsh-feishu-at` 加进去。

## 缺授权怎么办

插件**不会因为缺 lark-cli / 未登录 / 缺 scope 而报错或消失**：`@` 菜单会多出一组
「飞书授权 / 配置」提示行，标题说明缺什么，右侧描述给出可直接执行的命令（选中提示行不会插入内容）。
先按提示行处理，再按需刷新页面或重启 DSH。

| 提示行 | 含义 | 在系统终端执行 |
|---|---|---|
| 未安装 lark-cli | 本机找不到 `lark-cli` | `npm i -g @larksuite/cli && lark-cli config init && lark-cli auth login`，然后重启 DSH |
| lark-cli 未配置飞书应用 | 没有 app-id / app-secret | `lark-cli config init`（填 app-id 与 app-secret），再 `lark-cli auth login` |
| 飞书未登录 | user 身份不可用或已过期 | `lark-cli auth login`（按提示打开验证链接完成授权） |
| 飞书授权缺少 scope | 登录身份没覆盖某个接口所需权限 | 按提示行里的命令执行，如 `lark-cli auth login --scope "contact:department.base:readonly"`；scope 名来自 lark-cli 报错的 `missing_scopes` |
| 部门名称无权限 | 只缺部门名（部门行降级为 ID） | `lark-cli auth login --scope contact:department.base:readonly` |

> 授权命令要在**系统终端**里跑，不要粘到 DSH 的浏览器地址栏。改 Host 半后需重启 DSH；
> 只刷新页面只影响 Client 半。

一次性自查（把端口换成你当前 DSH Web GUI 的端口）：

```bash
curl -s 'http://127.0.0.1:<DSH Web 端口>/api/dsh-feishu-at/status' | python3 -m json.tool
```

`status` 里的 `cli.found` / `auth.ready` 是能力结论，`issues[]` 是当前问题清单（`kind` / `title` / `detail` / `fix` / 可选 `scopes`），`fix` 就是上表第三列的命令。

## 使用

1. 在会话输入框敲 `@`；菜单出现「最近会话」（群聊 + 私聊，按最近活跃排序）。
2. 继续输入，例如 `@张`、`@有货`、`@商品`，候选按用户/群聊/部门分节出现。
3. `↑/↓` 或鼠标选择，`Enter` 或 `Tab` 选中；`Esc` 关闭。选中后输入框里是 `@名称` 块。
4. 正常发送。模型收到的是带 ID 与 ID 类型的文本，可直接据此用 `lark-cli` 发消息、查群、查部门成员等。

> 搜索走 `lark-cli contact +search-user` / `lark-cli im +chat-search`（群聊）/ 原生 `contact/v3/departments/search`；
> 私聊（`p2p`）不在飞书的群聊搜索接口里，由插件本地维护「群聊 + 私聊」全量会话索引（`im +chat-list --types p2p,group`，
> 首次约 3–4s，缓存 10 分钟并在后台预热/刷新）后按名称过滤。
> 每条 lark-cli 命令约 0.8–1.5s，插件在 Host 侧做了 120s 结果缓存与并发去重，重复前缀（如先 `张` 再 `张志`）会很快；首次搜索稍慢属正常。

## 配置（可选，profile 的 `cordis.patch.yml`）

```yaml
- id: feishu-at
  config:
    larkCliPath: $HOME/.local/bin/lark-cli  # 缺省自动探测
    identity: user                                   # 目前只支持 user
    timeoutMs: 8000                                  # 单条 lark-cli 超时
    cacheTtlMs: 120000                               # 搜索结果缓存 TTL
```

## 实现结构

```
index.js        Host 半：execFile 调 lark-cli → /api/dsh-feishu-at/search|status（内存缓存 + 并发去重 + 权限降级）
client.js       Client 半：向 ctx.inputTriggers 注册 '@' 来源，同源 fetch Host 路由，插引用块、提交时按 codec 序列化
cordis.patch.yml  bundle patch：插入 id=feishu-at 一行
locale/*.json   Plugin Manager / 设置页显示用的标题与描述
icon.svg        插件图标
```

- Host 路由：`GET /api/dsh-feishu-at/search?q=&types=user,chat,dept&limit=8`、`GET /api/dsh-feishu-at/status`。
  结果顺序固定为 部门 → 群聊 → 私聊 → 人；Client 侧每类再截到 5 条（最近会话不按类截断）。
  `/status` 的 `lastRequests` 是最近 20 条请求的观测（时间 / q / User-Agent / Referer），可用来确认浏览器半是否真的在调路由。
- 「永不 500」+「缺授权可见」：两个路由都返回 200，失败不以异常表达，而是回 `issues[]`
  （`kind`：`cli-missing` / `not-configured` / `auth-required` / `scope-missing` / `dept-names` / `search-failed`；
  `scope-missing` 带 `scopes`）。Client 把 `issues` 渲染成菜单提示行，选中返回 `'handled'`（不插入内容）。
- Client 只依赖 baseline 的 `react` 模块，无构建步骤、无 npm 依赖。
- 引用块 `appearance` 省略 → 输入框内显示 `@` + 名称；发送时按 `source:'feishu'` 路由到本插件的 `codec.serialize`。

## 排障

| 现象 | 处理 |
|------|------|
| 敲 `@` 只有文件/会话，没有飞书分组 | 看菜单里是否有「飞书授权 / 配置」提示行；没有则 `curl -s 'http://127.0.0.1:<DSH Web 端口>/api/dsh-feishu-at/status'` 看 `cli.found` / `auth.ready` / `issues`；Host 半改动需重启 DSH 才生效 |
| 提示行「飞书 @ 提及未就绪」 | Host 路由 404：插件没启用或 Host 半没加载，确认 plugins/profile bundles 后重启 DSH |
| `cli.found=false` | 装好 lark-cli 或在配置里指定 `larkCliPath` |
| `auth.ready=false` | `lark-cli auth login`（user 身份） |
| 部门行只显示 `od-…` | `lark-cli auth login --scope contact:department.base:readonly` 授权后重载本插件（插件页关一下再开）或重启 DSH |
| 首次搜索慢 | lark-cli 每次冷启动 ~1s；插件缓存 120s，属预期 |
