# AGENTS.md — LQBot

面向在本仓库协助开发**框架**的 AI Agent / 协作者：项目背景、关键约定、命令与坑位。改动前先读这份文件与 README.md。
给机器人**编写插件（命令）**的开发指南见 [docs/PLUGIN-DEV.md](docs/PLUGIN-DEV.md)，不在本文件范围内。

## 项目简介
LQBot：跑在 EdgeOne 边缘函数上的无服务器 QQ 官方机器人。接收 QQ 官方 Webhook（群 @消息、私聊消息），通过 fetch 调用 QQ OpenAPI 发送消息，用 KV 数据库持久化。不考虑频道（Guild）场景。完整说明见 README.md 与 docs/。

## 目录结构

```text
LQBot/
├── edge-functions/              # 仅对外暴露的接口
│   └── webhook.ts               # POST /webhook 入口（onRequest）
├── src/                         # 框架内部模块（边缘构建打包进函数）
│   ├── lib/
│   │   ├── config.ts            # 运行时配置（从 env + globalThis.LQBOT 构建）
│   │   ├── storage.ts           # KV 持久化封装（命名空间 × 作用域：global/group/user）
│   │   ├── dedupe.ts            # 消息去重（窗口内 msg_id 汇总到单 key）
│   │   ├── crypto.ts            # Webhook 的 Ed25519 签名/验签
│   │   ├── tweetnacl.js         # vendored 纯 JS Ed25519（无类型，保留 .js）
│   │   ├── qq.ts                # QQ OpenAPI 客户端（token/发群/发私聊/查成员）
│   │   ├── permissions.ts       # 权限解析 3>2>1>0
│   │   ├── registry.ts          # 命令注册 + 解析 + 别名
│   │   ├── reply.ts             # 按场景构造被动回复
│   │   └── handler.ts           # Webhook 主逻辑（验签/地址校验/分发/去重/权限/执行）
│   └── commands/                # 插件命令（permission/debug），开发指南见 docs/PLUGIN-DEV.md
├── scripts/
│   └── register.ts             # 指令面板同步脚本（npm run register）
├── docs/                        # 项目文档（DEPLOY / PLUGIN-DEV / SUMMARY）
├── .env.example
├── package.json
├── README.md
├── AGENTS.md
└── LICENSE
```

## 关键技术约定（改动前必读）
1. Webhook 签名 = Ed25519（不是 HMAC）。地址校验 op=13 签 event_ts+plain_token；事件校验签 timestamp+body 对 X-Signature-Ed25519。
   关键坑：EdgeOne 边缘运行时 WebCrypto 不支持 Ed25519（importKey/sign 均报 Param Invalid），因此 vendored 了 tweetnacl（src/lib/tweetnacl.js，公有领域、RFC8032）。**不要尝试改用 WebCrypto。** 种子派生与官方 Go 一致：secret 重复拼接到 ≥32 字节再截断。
   事件验签默认**开启**（设 VERIFY_EVENT_SIGNATURE=false 才关闭）；验签密钥优先 WEBHOOK_SECRET、回退 APP_SECRET；时间戳（X-Signature-Timestamp）偏差 >10 分钟直接拒绝（防重放）；密钥为空时直接验签失败（不进入派生，避免死循环）。
2. 源码是 TypeScript（.ts），但 import 语句一律用 .js 扩展名（NodeNext 规范），esbuild 会解析到对应的 .ts 文件。移动/新增模块时 import 仍写 .js 后缀。
3. tsconfig 的 module 与 moduleResolution 必须同为 NodeNext。tweetnacl.js 无类型，靠 allowJs:true 被引用；**保持 vendored 原样，不要改成 .ts 或加强类型**。
4. src/ 在 edge-functions/ 之外，但边缘构建（esbuild）会跟随相对 import 打包，已实测可用。edge-functions/ 只放对外接口。
5. KV 是全局变量 **LQBOT**（globalThis.LQBOT），不在 context.env；控制台绑定时的「变量名」必须设为 LQBOT。统一走 src/lib/storage.ts，两级结构：**命名空间**（storage.infra 前缀 bot: 为跨模块基础设施；storage.ns('<模块>') 前缀 <模块>: 为业务数据）× **作用域**（.global 全局变量；.group(gid)/.user(uid)/.scene(ctx) 场景变量，按 openid 隔离）。key 形如 <ns>:global:<key> / <ns>:group:<gid>:<key> / <ns>:user:<uid>:<key>。未绑定时 available === false，读写自动跳过。
6. 命令处理**同步 await 后再返回** { op: 12 } 200（边缘运行时可能在返回 200 后立即冻结 isolate，waitUntil 后台跑会丢失回复与日志；被动回复窗口群 5 分钟 / 单聊 60 分钟，同步处理完全来得及）。被动回复携带**消息 id 作 msg_id**（取自 d.id，形如 ROBOT1.0_...），**不是 event_id**（event.id 是事件 id 形如 C2C_MESSAGE_CREATE:...，被动回复不认）。
7. QQ API 返回结构（尤其群成员 role/nick）官方文档未完整开放，相关代码已做兼容，实测字段不同需校准。

## 构建 / 开发 / 部署
- 构建：PAGES_SOURCE=skills edgeone makers build
- 本地开发：PAGES_SOURCE=skills edgeone makers dev -n LQBot（访问 http://127.0.0.1:8088/）
- 部署：PAGES_SOURCE=skills edgeone makers deploy -n LQBot
- 同步指令面板：npm run register（将 src/commands 命令同步为 QQ 指令面板；先快照再删重建、出错自动回滚；等级≥3 仅私聊按用户限定）。
- 环境变量见 .env.example：APP_ID / APP_SECRET（或 WEBHOOK_SECRET）/ SUPER_ADMIN_OPENID / QQ_API_BASE / VERIFY_EVENT_SIGNATURE / CHECK_GROUP_ADMIN / GROUP_SCENE_LEVEL
- 部署前先在 EdgeOne 控制台开通 KV 并绑定命名空间，**变量名设为 LQBOT**。

## EdgeOne Skills（官方 AI Agent 技能包）

官方文档：https://cloud.tencent.com/document/product/1552/129329

Skills 是一套社区开放规范，以结构化 Markdown 为 AI Agent 注入特定领域的专业知识与操作流程；
支持 Claude Code、CodeBuddy、Cursor 等所有支持 Skills 机制的 AI 编程工具。

- **技能包**：`edgeone-makers-tools`（TencentEdgeOne/edgeone-makers-tools），按领域组织 8 个子 Skill，Agent 按任务自动匹配加载：

  | 子 Skill | 覆盖范围 |
  |---|---|
  | makers-agents | AI Agent 开发（DeepAgents、LangGraph、Claude Agent SDK、OpenAI Agents、CrewAI） |
  | makers-edge-functions | Edge Functions（V8 轻量运行时）——**本项目核心** |
  | makers-cloud-functions | Cloud Functions（Node.js / Go / Python） |
  | makers-storage | KV 与 Blob 存储——**本项目核心** |
  | makers-middleware | 中间件（鉴权、重写、路由） |
  | makers-deploy | 部署项目到 EdgeOne |
  | makers-cli | EdgeOne CLI 命令参考 |
  | makers-recipes | 项目结构模板与脚手架 |

- **安装**：`npx skills add TencentEdgeOne/edgeone-makers-tools`；访问 GitHub 受限时走 SkillHub 商店
  （先按 https://skillhub.cn/install/skillhub.md 装 CLI，再装 edgeone-makers-tools 技能）。
- **使用**：用自然语言描述需求，Agent 自动判断并执行；描述里带上明确关键词（「EdgeOne Makers」「Edge Functions」「KV」「中间件」等）触发更准。
  开发类流程：需求分析（选 Agent 框架 / Edge / Cloud Functions / 中间件）→ 按平台规范生成代码 → `edgeone makers dev` 本地调试（默认端口 8088）。
- **登录**：本地桌面环境自动走浏览器登录；远程服务器用 API Token（中国站 / 国际站账号体系相互独立，按账号所属站点选择）。
  **API Token 是账户级权限，切勿提交到代码仓库。**
- **与本项目的对应关系**：LQBot = Edge Functions（webhook 入口 + 命令处理）+ KV（LQBOT 绑定），
  开发/排障重点参考 makers-edge-functions 与 makers-storage；部署与 CLI 问题看 makers-deploy、makers-cli。

## 权限系统
等级（挡位进阶，高等级拥有低等级全部权限）：
  3 超级管理员  来自 env SUPER_ADMIN_OPENID
  2 全局管理员  由超管通过 /permission 设置（落 KV perm:user:<openid>:level）
  1 群聊管理员  默认「场景值」；可经 /permission 覆盖
  0 普通用户    默认「场景值」；可经 /permission 覆盖
解析顺序（resolveLevel）：env 超管 → KV 显式覆盖 → 场景默认。私聊按群管(1)处理；群聊默认 GROUP_SCENE_LEVEL，开 CHECK_GROUP_ADMIN 时按群成员 role 识别真实群管。详见 permissions.ts。
清除覆盖：/permission <openid> reset（删除 KV perm:user:<openid>:level，回到场景默认）。

## 命令系统（框架侧）
- 触发：群聊 @机器人 消息、私聊消息。格式 /<command> [args]，解析在 registry.ts（剥离 @机器人 前缀、小写匹配、含别名）。
- 命令注册表：src/lib/registry.ts 的 commands 数组，插件模块从这里挂载（开发指南见 docs/PLUGIN-DEV.md）。
- handler 接收的 ctx 包含：args, raw, original, scene, userOpenid, memberOpenid, groupOpenid, nick, level, memberInfo, event, messageId, cfg, qq, reply, deny。
- 持久化：命令经 ctx.cfg.storage 访问 KV（两级：命名空间 × 作用域，见关键技术约定 5）；用法与示例见 docs/PLUGIN-DEV.md。
- 权限按挡位比较（level >= minLevel 通过；否则调用 ctx.deny() 回复）。反馈由 reply 按场景被动发送。

## 验证
- op=13 地址校验：POST {"d":{"plain_token":"Arq0D5A61EgUu4OxUvOp","event_ts":"1725442341"},"op":13} 到 /webhook，应返回固定签名
  87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706（MATCH=True）。这是验证签名/种子派生正确的最快方法。
- 任何改动后跑一次 edgeone makers build 确认编译通过。

## 已知坑位 / 边界
- getAppAccessToken 请求体字段名是 **appId**（不是 clientId）；改用 clientId 会返回 {code:100007,"appid invalid"}，即使凭证正确。当前 body 同时带 appId 与 clientId 以兼容旧文档。
- 指令面板接口 POST /v2/panels 频率 10 QPM、每机器人最多 20 个；元素 desc 最多 30 字符（超长直接 40030013 失败）。群聊面板 target 只能按群(group_openids)限定、无法按用户精确限定，故等级≥3 命令只在私聊(c2c)面板注册（见 scripts/register.ts 的 buildNewPanels）。私聊「管理员面板」包含全部命令且仅超管可见——QQ 对被 specific 面板命中的用户可能只展示该面板、隐藏 all 面板，否则超管私聊看不到通用命令。
- 被动回复（发群/发私聊消息）用请求体字段 **msg_id**（值=接收到的消息 id d.id，形如 ROBOT1.0_...）。若误用 event_id 或误填顶层事件 id（C2C_MESSAGE_CREATE:...）会报 40034025「event_id 无效」或 40034027「event_id 对应事件不能回复消息」。
- 群成员接口 GET /v2/groups/{group_openid}/members（及 role/nick 字段）官方文档未完整开放；permissions.ts 的 isGroupAdminRole（当前：role 含 admin/owner/群主 或 数字>=2 判群管）需按实测校准。
- 主动消息限频（群/单聊 每月 4 条）由 QQ 侧控制；本项目优先被动回复。
- GROUP_SCENE_LEVEL 非法值会被 clamp 到 0-3 并回退 1（config.ts）；不校验的话 NaN 参与 `level < minLevel` 恒为 false，会导致权限 fail-open。
- .env 含官方文档示例密钥，仅本地签名验证用，上线请替换为真实凭证且勿提交（.gitignore 已忽略 .env 与 .edgeone）。

## Git / 提交约定（本仓库）
- 提交信息用 Conventional Commits：<type>(<scope>): <中文摘要>。type ∈ feat / fix / refactor / chore / docs，scope 用英文模块名。
- 一个提交只做一件事，按任务拆分（不要混合不相关改动）。
- 红线：未收到用户明确指令前，绝对不要执行 git commit 或 git push。完成改动后等用户说「提交」再提交，且默认不 push。
