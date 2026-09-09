LQBot —— Serverless QQ 官方机器人（EdgeOne 边缘函数）会话总结

本文件汇总当前会话（项目搭建）的目标、架构、关键技术决策、验证结果与后续事项。

============================================================
一、项目是什么
============================================================
一个跑在 EdgeOne 边缘函数上的 serverless QQ 官方机器人服务：
- 接收 QQ 官方服务器的 Webhook 推送（群聊 @消息、私聊消息）
- 通过 fetch 调用 QQ OpenAPI 发送消息
- 使用 KV 数据库持久化权限等数据
- 内置「挡位进阶权限系统」+「插件式命令系统」+ 两个内置命令（/permission、/debug）
- 不考虑频道（Guild）场景

项目名：LQBot（仓库目录仍为 qbot：D:/Code/jsucraft/qbot，可在本地按需重命名）。

============================================================
二、目录结构（当前）
============================================================
LQBot/
  edge-functions/            # 仅对外暴露的接口
    webhook.ts                # POST /webhook 入口（onRequest）
  src/                       # 所有内部模块（被边缘构建打包进函数）
    lib/
      config.ts              # 从 env 构建运行时配置
      storage.ts             # KV 持久化封装（命名空间 × 作用域：global/group/user）
      dedupe.ts              # 消息去重（窗口内 msg_id 汇总到单 key）
      crypto.ts             # Ed25519 签名/验签（基于 tweetnacl）
      tweetnacl.js          # vendored 纯 JS Ed25519（已去掉 require('crypto')）
      qq.ts                 # QQ OpenAPI 客户端（token/发群/发私聊/查成员）
      permissions.ts         # 权限解析 3>2>1>0
      registry.ts            # 命令注册 + 解析 + 别名
      reply.ts               # 按场景构造被动回复
      handler.ts             # 验签/地址校验/事件分发/去重/权限/执行/兜底
    commands/
      permission.ts          # /permission [openid] [int]   群+私聊  level 3
      debug.ts               # /debug [args]               群+私聊  level 0
  scripts/                  # 指令面板同步脚本（npm run register -> register.ts）
  .env.example
  package.json
  README.md
  .gitignore                 # 忽略 .env / .edgeone / node_modules
  docs/SUMMARY.md            # 本文件

说明：edge-functions 只放对外接口；其余代码放在 src/，由边缘构建（esbuild）跟随相对
导入 ../../src/... 打包进函数产物。已实测：构建能正确打包 edge-functions/ 之外的 src/。

============================================================
三、关键技术决策（均经实测确认）
============================================================
1) Webhook 签名 = Ed25519（不是 HMAC）
   依据官方文档 sign.md / event-emit.md：
   - 地址校验(op=13)：msg = event_ts + plain_token，用由 botSecret 派生的私钥签名，
     响应返回 { plain_token, signature }。
   - 事件校验：msg = timestamp + body（原始 body），与请求头
     X-Signature-Ed25519 / X-Signature-Timestamp 比对。
   - 种子派生（与官方 Go 示例一致）：把 secret 重复拼接直到 >=32 字节，再截断到 32 字节。

2) 边缘运行时 WebCrypto 不支持 Ed25519（重要坑）
   实测 EdgeOne 边缘运行时：importKey / sign / generateKey（Ed25519）全部抛出
   "Param Invalid"（包括 raw / jwk / pkcs8 各种变体），但 SHA-512 digest 正常。
   因此 vendor 了公有领域的 tweetnacl（RFC 8032，自包含、自带 SHA-512），其签名与
   Go crypto/ed25519 逐字节一致。已用 Node 与边缘运行时两端验证。

3) 本地 ES 模块 import 会被 esbuild 打包
   实测 edge-functions 内及 src/ 内的相对 import 都会被正确内联进产物。

4) KV 是全局变量 LQBOT（不在 context.env）
   config.ts 通过 globalThis.LQBOT 获取并包成 storage.ts 的 Storage（两级：命名空间 infra/ns('<模块>')
   × 作用域 global/group/user/scene）；未绑定时 storage.available === false，读写自动跳过。

5) 命令处理放 waitUntil，先回 200 ACK(op=12)
   被动回复窗口（群 5 分钟 / 单聊 60 分钟）足够；先回 200 保证 QQ 投递成功。

============================================================
四、权限系统
============================================================
等级（挡位进阶，高一档拥有低一档全部权限）：
  3 超级管理员  来自环境变量 SUPER_ADMIN_OPENID
  2 全局管理员  由超级管理员通过 /permission 设置，落 KV
  1 群聊管理员  默认「场景值」；可经 /permission 覆盖
  0 普通用户    默认「场景值」；可经 /permission 覆盖

解析顺序（resolveLevel）：
  1. 超级管理员（env, 3）
  2. KV 显式覆盖 perm:user:<user_openid>:level（0-3）
  3. 场景默认值

场景规则：
  - 私聊消息权限同群聊管理员（1）。
  - 群聊默认返回 GROUP_SCENE_LEVEL（默认 1）；开启 CHECK_GROUP_ADMIN 时调用群成员
    接口按 role 识别真实群管（命中 → 1，否则 0）。
  - 「群管/普通用户自动按场景获取、不落库、设置后覆盖场景值」= 场景默认 + KV 覆盖机制。

============================================================
五、命令系统
============================================================
- 触发：群聊 @机器人 消息、私聊消息。
- 格式：/<command> [args]（参数可无可有多个）。命令模块导出：
  name / aliases / description / scenes(['group','private']) / minLevel / handler(ctx)
- 权限：由各 handler 用挡位比较（level >= minLevel 通过；否则拒绝回复）。
- 反馈：按场景自动发到群（群聊）或私聊（单聊），被动回复携带事件消息 id 作 event_id。
- 新增命令：在 src/commands/ 建模块（含 export default {...}），并在 src/lib/registry.ts
  的 commands 数组里 import。

============================================================
六、内置命令
============================================================
/permission（别名 /perm）[<user_openid> [<0-3>|reset]]   群聊+私聊   等级 3（超级管理员）
  - 无参：返回你当前场景权限
  - 1 参：返回该用户当前场景权限（含 KV 覆盖值）
  - 2 参：把该用户权限设为 0-3（写入 KV perm:user:<user_openid>:level）；reset 清除覆盖

/debug [args]                           群聊+私聊   等级 0
  - 回显：原消息、参数、参数数量、用户 openid、用户权限、用户昵称、场景

============================================================
七、用到的官方 QQ API（已核对文档）
============================================================
鉴权：
  POST https://bots.qq.com/app/getAppAccessToken
  body: { clientId: APP_ID, clientSecret: APP_SECRET }
  → { access_token }，请求头 Authorization: QQBot <access_token>（token 缓存进 KV）

事件（op=0 时的 t 字段）：
  C2C_MESSAGE_CREATE        d.author.user_openid；content 即文本
  GROUP_AT_MESSAGE_CREATE   d.author.member_openid、d.group_openid；@ 已被剥离

发送：
  POST /v2/groups/{group_openid}/messages       body { content, msg_type:0, event_id }
  POST /v2/users/{user_openid}/messages          body { content, msg_type:0, event_id }
  （event_id = 事件消息 id，用于被动回复；超出窗口则只能走主动消息）

群成员（用于映射 member_openid→user_openid、昵称、role）：
  GET /v2/groups/{group_openid}/members/{member_openid}
  GET /v2/groups/{group_openid}/members?limit=&after=

============================================================
八、验证结果（已执行）
============================================================
1. edgeone makers build：编译成功，src/ 被正确打包。
2. edgeone makers dev 起服务后 POST 官方 op=13 示例：
     请求体 {"d":{"plain_token":"Arq0D5A61EgUu4OxUvOp","event_ts":"1725442341"},"op":13}
     返回签名 = 87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706
     与官方文档期望值 MATCH=True（证明 Ed25519 签名算法与种子派生完全正确）。
3. POST GROUP_AT_MESSAGE_CREATE + /debug a b c：
     返回 200 ACK，日志显示命令被正确解析、尝试 getGroupMember、尝试 reply；
     仅在 getAppAccessToken 因测试用的假 APP_ID(11111111) 报 appid invalid 失败 —— 符合预期。
     （换真实 APP_ID/APP_SECRET 后即正常。）
4. tweetnacl 在 Node 复现官方签名一致；边缘运行时 WebCrypto Ed25519 逐变体确认不可用。

============================================================
九、部署步骤
============================================================
1. EdgeOne Makers 控制台开启 KV 存储 → 创建命名空间 → 绑定到本项目，变量名设为 LQBOT。
2. 配置环境变量（见 .env.example）：
   APP_ID / APP_SECRET / SUPER_ADMIN_OPENID（其余可选）。
3. 本地开发：
   PAGES_SOURCE=skills edgeone makers dev -n LQBot
   访问 http://127.0.0.1:8088/
4. 部署：
   PAGES_SOURCE=skills edgeone makers deploy -n LQBot
5. （可选）同步指令面板：
   npm run register
   把 src/commands 下命令（含别名）同步为 QQ 指令面板（等级≥3 仅私聊按用户限定；先快照再重建、出错回滚）。
6. QQ 开放平台「开发设置 → 回调地址」填写：
   https://<你的边缘函数域名>/webhook
   平台先发 op=13 地址校验，本服务自动签名通过。

============================================================
十、待确认假设 / 边界
============================================================
- 群成员接口返回结构（role / nick 字段）官方文档未完整开放，代码已做兼容：
  若实测字段不同，需调整 src/lib/permissions.ts 的 isGroupAdminRole（当前：role 含 admin/owner/群主 或 数字>=2 判为群管）。
- 主动消息限频（群/单聊 每月 4 条）由 QQ 侧控制；本项目优先使用被动回复。
- 当前 .env 中的 APP_SECRET 为官方文档示例密钥（仅用于本地签名验证），上线请替换为真实凭证。

============================================================
十一、本次会话完成的改动清单
============================================================
- 初始化项目骨架：package.json、.env.example、README.md、.gitignore
- 实现权限系统、命令系统、两个内置命令（/permission、/debug）
- vendor tweetnacl 到 src/lib/tweetnacl.js（因边缘运行时缺 Ed25519）
- 按用户要求把内部模块从 edge-functions/{lib,commands} 迁移到 src/，
  edge-functions 仅保留 webhook.ts；同步更新 README 目录树与「新增命令」指引
- 全程未执行 git commit / push（需用户明确授权）
