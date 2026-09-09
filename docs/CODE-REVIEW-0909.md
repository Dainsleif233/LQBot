# LQBot 代码审查报告

> 审查日期：2026-09-09 · 审查范围：全部源码（edge-functions / src / scripts）+ 配置 + 构建验证

## 一、验证结果（全部实测通过 ✅）

| 验证项 | 结果 |
|---|---|
| op=13 官方 KAT（用官方示例密钥 `DG5g3B4j9X2KOErG`，见官方文档「安全和授权」页） | **MATCH = true**，与官方文档期望签名逐字符一致 |
| 验签自洽性（sign→verify 回环） | 大写签名通过、篡改 1 位/换报文/长度不符均正确拒绝 |
| `edgeone makers build` | ✅ Compiled edge functions successfully |
| `tsc --noEmit`（strict 模式） | ✅ 0 错误 |

密码学实现（种子派生 + vendored tweetnacl Ed25519）**确认正确**；协议关键细节（`msg_id` 用 `d.id`、token 请求体用 `appId`、KV 全局变量 `LQBOT`、同步 await 后再返回 200）均与 AGENTS.md 约定一致。

> 注：用仓库当前 `.env` 密钥跑 KAT 不匹配，查证后确认是 `.env` 已非官方示例密钥（现含真实凭证，已被 .gitignore 忽略 ✓），换官方示例密钥后 MATCH。

## 二、发现的问题（按严重度）

### 🔴 高（安全，建议尽快处理）

#### H1. 事件验签默认关闭 + 按 payload 中的 openid 判权 → 可伪造提权

`VERIFY_EVENT_SIGNATURE` 默认 `false`。此时任何知道 webhook URL 的人可伪造 op=0 事件，把 `d.author.user_openid` 填成 `SUPER_ADMIN_OPENID` 即获等级 3，并用 `/permission` 把自己写入 KV——**之后即使开启验签，该提权依然生效**（需手动 reset 清除）。这是一条完整的接管路径。

**建议**：默认改为 `true`（或密钥未配置时拒绝处理 op=0）。

#### H2. `deriveSeed('')` 死循环

APP_SECRET 与 WEBHOOK_SECRET 均未配置时 `appSecret=''`。op=13 路径有 `if (!cfg.appSecret)` 守卫（handler.ts），但 **op=0 + VERIFY_EVENT_SIGNATURE=true** 时会走 `verifyWebhookSignature('')` → `deriveSeed` 中 `while (seed.length < 32) seed += secret` 对空串**无限循环，isolate 挂死**。

**建议**：在 `verifyWebhookSignature` 开头加 `if (!secret) return false;`。

### 🟡 中

- **M1. 验签不校验时间戳新鲜度（重放窗口）**：签名只覆盖 `timestamp+body`，不检查 `X-Signature-Timestamp` 与当前时间偏差，合法抓包可无限期重放；去重窗口仅 10 分钟，超过后重放会再次执行。**建议**：偏差 >5~10 分钟即拒绝。
- **M2. `WEBHOOK_SECRET` 被静默忽略**：`config.ts` 写 `APP_SECRET || WEBHOOK_SECRET`——两者同时设置时 WEBHOOK_SECRET 完全不生效，与 `.env.example`「可选的独立 webhook 签名密钥」描述不符。**建议**：要么真支持分离（签名用 WEBHOOK_SECRET、token 用 APP_SECRET），要么改注释。
- **M3. `GROUP_SCENE_LEVEL` 非数字时 fail-open**：`parseInt('abc')` 得 NaN，`level < cmd.minLevel` 恒 false → **所有人通过所有权限检查**。**建议**：对解析结果 clamp 到 0–3，非法回退 1。

### 🟢 低 / 建议

- **L1** `/permission` 查询目标用户「场景默认」时，`resolveLevel` 收到的是调用者的 `memberOpenid`/`memberInfo`——开启 CHECK_GROUP_ADMIN 时展示的等级反映的是**调用者**的群角色而非目标（仅展示误导）。
- **L2** `reply.ts`/`handler.ts` 的 `d.id || event.id` 回退：`event.id` 是事件 id，作 msg_id 必被 QQ 拒（40034025/27），回退只会把本地缺 id 变成 API 报错，不如缺 `d.id` 时直接 throw。
- **L3** dedupe 单 key 读改写存在并发竞态，极端情况重复投递漏判——注释已声明取舍，QQ 重投间隔秒级，可接受。
- **L4** 种子派生按 UTF-16 **字符**重复拼接，官方 Go 按**字节**；ASCII 密钥一致（KAT 已证），非 ASCII 密钥会派生不同种子。实际 AppSecret 为 ASCII，加注释即可。
- **L5** `register.ts` 用正则解析源码收集命令，绕开了 registry.ts 唯一数据源：`export const name = '...'` 只匹配单引号写法，双引号会**静默漏掉命令**导致面板与实际不一致。**建议**：tsx 可直接 import registry.ts，改为真实导入。
- **L6** `register.ts` 面板 DELETE/POST 循环无节流（>~9 次操作可能触发 10 QPM 限频）；per-scope 出错被 catch 吞掉后 `main` 仍以 exit 0 结束。
- **L7** 小项：
  - `types.ts` QqApi 接口参数名 `eventId` 实为 msg_id（命名误导）；
  - `reply.ts` 头注释仍写「event_id」与实现（msg_id）矛盾，注释过期；
  - `handler.ts` 的 `levelNameSafe` 与 `permissions.levelName` 重复实现，可直接 import；
  - `permissions.ts` 的动态 `import('./qq.js')` 无循环依赖，可改静态导入；
  - deny 回复把所需等级明文暴露给用户（信息展示取舍，无碍）。

## 三、总体评价

架构清晰、模块职责分明，AGENTS.md 声明的坑位（WebCrypto 不支持 Ed25519、appId 字段名、msg_id vs event_id、KV 变量名）在实现中全部正确落实，官方测试向量与构建/类型检查均通过。**主要风险集中在 H1/H2/M3 三个安全默认值与配置边界**，都是几行的修复量。

## 附：涉及文件索引

| 文件 | 相关问题 |
|---|---|
| `src/lib/config.ts` | H1（默认值）、H2（空 secret）、M2、M3 |
| `src/lib/crypto.ts` | H2（deriveSeed 死循环）、L4 |
| `src/lib/handler.ts` | H1（验签开关）、M1（时间戳）、L2、L7 |
| `src/lib/reply.ts` | L2、L7 |
| `src/lib/permissions.ts` | L1、L7 |
| `src/lib/dedupe.ts` | L3 |
| `src/lib/types.ts` | L7（QqApi 参数名） |
| `src/commands/permission.ts` | L1 |
| `scripts/register.ts` | L5、L6 |
| `.env.example` | M2（与实现不符的描述） |
