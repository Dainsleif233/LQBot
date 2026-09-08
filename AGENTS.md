# AGENTS.md — LQBot

面向在本仓库工作的 AI Agent / 协作者：项目背景、关键约定、命令与坑位。改动前先读这份文件与 README.md。

## 项目简介
LQBot：跑在 EdgeOne 边缘函数上的无服务器 QQ 官方机器人。接收 QQ 官方 Webhook（群 @消息、私聊消息），通过 fetch 调用 QQ OpenAPI 发送消息，用 KV 数据库持久化。不考虑频道（Guild）场景。完整说明见 README.md 与 docs/SUMMARY.md。

## 目录结构
    LQBot/
      edge-functions/            # 仅对外暴露的接口
        api/webhook.ts           # POST /api/webhook 入口（onRequest）
      src/                       # 全部内部模块（被边缘构建打包进函数）
        lib/
          config.ts             # 运行时配置（从 env + globalThis.my_kv 构建）
          crypto.ts             # Webhook 的 Ed25519 签名/验签
          tweetnacl.js          # vendored 纯 JS Ed25519（无类型，保留 .js）
          qq.ts                 # QQ OpenAPI 客户端（token/发群/发私聊/查成员）
          permissions.ts        # 权限解析 3>2>1>0
          registry.ts           # 命令注册 + 解析 + 别名
          reply.ts              # 按场景构造被动回复
          handler.ts            # Webhook 主逻辑（验签/地址校验/分发/去重/权限/执行）
          types.ts              # 共享类型（Config/Command/CommandContext/...）
        commands/
          permission.ts         # /permission（别名 /perm）权限管理，level 3
          debug.ts              # /debug 调试命令，level 0，别名 /test
      package.json
      tsconfig.json
      README.md
      AGENTS.md                 # 本文件
      docs/SUMMARY.md           # 会话总结
      .env.example              # 环境变量示例（.env 已被 gitignore）

## 关键技术约定（改动前必读）
1. Webhook 签名 = Ed25519（不是 HMAC）。地址校验 op=13 签 event_ts+plain_token；事件校验签 timestamp+body 对 X-Signature-Ed25519。
   关键坑：EdgeOne 边缘运行时 WebCrypto 不支持 Ed25519（importKey/sign 均报 Param Invalid），因此 vendored 了 tweetnacl（src/lib/tweetnacl.js，公有领域、RFC8032）。**不要尝试改用 WebCrypto。** 种子派生与官方 Go 一致：secret 重复拼接到 ≥32 字节再截断。
2. 源码是 TypeScript（.ts），但 import 语句一律用 .js 扩展名（NodeNext 规范），esbuild 会解析到对应的 .ts 文件。移动/新增模块时 import 仍写 .js 后缀。
3. tsconfig 的 module 与 moduleResolution 必须同为 NodeNext。tweetnacl.js 无类型，靠 allowJs:true 被引用；**保持 vendored 原样，不要改成 .ts 或加强类型**。
4. src/ 在 edge-functions/ 之外，但边缘构建（esbuild）会跟随相对 import 打包，已实测可用。edge-functions/ 只放对外接口。
5. KV 是全局变量 my_kv（globalThis.my_kv），不在 context.env。任何用到 KV 的地方都做了 null 保护（未绑定则跳过持久化）。
6. 命令处理**同步 await 后再返回** { op: 12 } 200（边缘运行时可能在返回 200 后立即冻结 isolate，waitUntil 后台跑会丢失回复与日志；被动回复窗口群 5 分钟 / 单聊 60 分钟，同步处理完全来得及）。被动回复携带**消息 id 作 msg_id**（取自 d.id，形如 ROBOT1.0_...），**不是 event_id**（event.id 是事件 id 形如 C2C_MESSAGE_CREATE:...，被动回复不认）。
7. QQ API 返回结构（尤其群成员 role/nick）官方文档未完整开放，相关代码已做兼容，实测字段不同需校准。

## 构建 / 开发 / 部署
- 构建：PAGES_SOURCE=skills edgeone makers build
- 本地开发：PAGES_SOURCE=skills edgeone makers dev -n LQBot（访问 http://127.0.0.1:8088/）
- 部署：PAGES_SOURCE=skills edgeone makers deploy -n LQBot
- 环境变量见 .env.example：APP_ID / APP_SECRET（或 WEBHOOK_SECRET）/ SUPER_ADMIN_OPENID / QQ_API_BASE / VERIFY_EVENT_SIGNATURE / CHECK_GROUP_ADMIN / GROUP_SCENE_LEVEL
- 部署前先在 EdgeOne 控制台开通 KV 并绑定命名空间，变量名设为 my_kv。

## 权限系统
等级（挡位进阶，高等级拥有低等级全部权限）：
  3 超级管理员  来自 env SUPER_ADMIN_OPENID
  2 全局管理员  由超管通过 /permission 设置（落 KV perm:<openid>）
  1 群聊管理员  默认「场景值」；可经 /permission 覆盖
  0 普通用户    默认「场景值」；可经 /permission 覆盖
解析顺序（resolveLevel）：env 超管 → KV 显式覆盖 → 场景默认。私聊按群管(1)处理；群聊默认 GROUP_SCENE_LEVEL，开 CHECK_GROUP_ADMIN 时按群成员 role 识别真实群管。详见 permissions.ts。

## 命令系统
- 触发：群聊 @机器人 消息、私聊消息。格式 /<command> [args]。
- 新增命令：在 src/commands/ 新建模块，导出 name / aliases / description / scenes(['group','private']) / minLevel / handler(ctx)，并以 export default { … } 导出；再 import 到 src/lib/registry.ts 的 commands 数组。
- handler 接收的 ctx 包含：args, raw, original, scene, userOpenid, memberOpenid, groupOpenid, nick, level, memberInfo, event, messageId, cfg, qq, reply, deny。
- 权限按挡位比较（level >= minLevel 通过；否则调用 ctx.deny() 回复）。反馈由 reply 按场景被动发送。

## 验证
- op=13 地址校验：POST {"d":{"plain_token":"Arq0D5A61EgUu4OxUvOp","event_ts":"1725442341"},"op":13} 到 /api/webhook，应返回固定签名
  87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706（MATCH=True）。这是验证签名/种子派生正确的最快方法。
- 任何改动后跑一次 edgeone makers build 确认编译通过。

## 已知坑位 / 边界
- getAppAccessToken 请求体字段名是 **appId**（不是 clientId）；改用 clientId 会返回 {code:100007,"appid invalid"}，即使凭证正确。当前 body 同时带 appId 与 clientId 以兼容旧文档。
- 被动回复（发群/发单聊消息）用请求体字段 **msg_id**（值=接收到的消息 id d.id，形如 ROBOT1.0_...）。若误用 event_id 或误填顶层事件 id（C2C_MESSAGE_CREATE:...）会报 40034025「event_id 无效」或 40034027「event_id 对应事件不能回复消息」。
- 群成员接口 GET /v2/groups/{group_openid}/members（及 role/nick 字段）官方文档未完整开放；permissions.ts 的 isGroupAdminRole（当前：role 含 admin/owner/群主 或 数字>=2 判群管）需按实测校准。
- 主动消息限频（群/单聊 每月 4 条）由 QQ 侧控制；本项目优先被动回复。
- .env 含官方文档示例密钥，仅本地签名验证用，上线请替换为真实凭证且勿提交（.gitignore 已忽略 .env 与 .edgeone）。

## Git / 提交约定（本仓库）
- 提交信息用 Conventional Commits：<type>(<scope>): <中文摘要>。type ∈ feat / fix / refactor / chore / docs，scope 用英文模块名。
- 一个提交只做一件事，按任务拆分（不要混合不相关改动）。
- 红线：未收到用户明确指令前，绝对不要执行 git commit 或 git push。完成改动后等用户说「提交」再提交，且默认不 push。
