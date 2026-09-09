# LQBot

一个运行在 EdgeOne 边缘函数上的 QQ 官方机器人框架

- 接收 QQ 官方服务器的 Webhook 推送（群聊 @消息、私聊消息）
- 通过 QQ OpenAPI（fetch）发送消息
- 使用 KV 数据库持久化数据（权限等）
- 内置挡位权限系统与插件式命令系统

## 目录结构

```text
LQBot/
├── edge-functions/              # 仅对外暴露的接口
│   └── webhook.ts               # POST /webhook 入口
├── src/                         # 内部模块（边缘构建打包进函数）
│   ├── lib/
│   │   ├── config.ts            # 运行时配置（env + LQBOT）
│   │   ├── storage.ts           # KV 持久化封装（命名空间化）
│   │   ├── dedupe.ts            # 消息去重（窗口内 msg_id 汇总到单 key）
│   │   ├── crypto.ts            # Ed25519 签名/验签
│   │   ├── tweetnacl.js         # vendored 纯 JS Ed25519
│   │   ├── qq.ts                # QQ OpenAPI 客户端（token / 发消息）
│   │   ├── permissions.ts       # 权限解析（3>2>1>0）
│   │   ├── registry.ts          # 命令注册与解析
│   │   ├── reply.ts             # 按场景被动回复
│   │   └── handler.ts           # Webhook 主逻辑
│   └── commands/
│       ├── permission.ts        # /permission 权限管理（level 3）
│       └── debug.ts             # /debug 调试命令（level 0）
├── scripts/
│   └── register.ts             # 指令面板同步脚本（npm run register）
├── docs/
│   └── SUMMARY.md
├── .env.example
├── package.json
├── README.md
├── AGENTS.md
└── LICENSE
```

## 部署与配置

1. 开通 KV 存储并绑定命名空间
   - EdgeOne Makers 控制台 -> KV 存储 -> 申请 -> 创建命名空间
   - 绑定到本项目，**变量名设为 LQBOT**（代码里作为全局变量 LQBOT 访问；必须与控制台一致）

2. 配置环境变量
   - 本地：复制 .env.example 为 .env；或在 Makers 控制台设置：
     APP_ID / APP_SECRET（QQ 机器人凭证）、SUPER_ADMIN_OPENID（等级 3 用户 openid，可通过/debug 获取）等

3. 本地开发

   npm install -g edgeone
   PAGES_SOURCE=skills edgeone makers dev -n LQBot

4. 部署

   PAGES_SOURCE=skills edgeone makers deploy -n LQBot

5. 配置 QQ 回调地址
   - 在 QQ 开放平台「开发设置 -> 回调地址」填写：https://<你的边缘域名>/webhook
   - 平台先发 op=13 地址校验。本服务用 APP_SECRET（或 WEBHOOK_SECRET）派生 Ed25519
     私钥，对 event_ts + plain_token 签名并返回，自动通过校验。

## 指令面板（命令菜单）同步

`npm run register`（内部 `npx tsx scripts/register.ts`）把 `src/commands/` 下注册的命令
（含别名）同步为 QQ 机器人的「指令面板」，方便用户在聊天框一键触发。

- 数据源与命令系统同源：脚本直接读取 `src/commands/*.ts` 的 `name / aliases / description / minLevel`，
  不需要手动维护清单。
- 面板拆分规则：
  - 等级 < 3 的命令 → 「全量面板」（`target_type=all`，群聊与私聊都注册，所有人可见）。
  - 等级 ≥ 3 的命令 → 只在**私聊(c2c)** 面板按 `user_openids=[SUPER_ADMIN_OPENID]` 精确限定到超级管理员；
    群聊面板无法按用户精确限定（其 `target` 只能按群 `group_openids` 限定），故群聊不注册这些命令。
- 同步策略（对账式，避免重复/超配额）：先 `GET` 某场景现有面板并存入内存快照 → 删除全部 →
  按当前命令重建；**任一步出错则回滚**：再次获取并删光当前面板，再把内存中的原有面板原样还原。
- 元素规则：`name` 不带 `/`（脚本自动剥掉），别名也各自注册为独立元素；`minLevel >= 1` 的元素标
  `only_admin=true`。
- 依赖与限频：需要 `APP_ID / APP_SECRET（或 WEBHOOK_SECRET）/ SUPER_ADMIN_OPENID` 环境变量
  （来自 `.env`）以及 `QQ_API_BASE`（默认 `https://api.bot.qq.com`，官方 2026-08-10 起统一域名；
  沙箱/旧域可显式覆盖为 `https://sandbox.api.sgroup.qq.com`）。面板创建接口 **10 QPM**、每机器人最多 20 个面板；单个面板元素
  `desc` 最多 30 字符（超长会直接报 40030013 失败）。
- `npm start` = `npm run register && npm run deploy`，即先同步面板再部署。

## 权限系统

用户等级（挡位进阶，高等级拥有低等级全部权限）：

    Level 3  超级管理员   来自环境变量 SUPER_ADMIN_OPENID
    Level 2  全局管理员   由超级管理员通过 /permission 设置
    Level 1  群聊管理员   默认「场景值」，可通过 /permission 覆盖
    Level 0  普通用户     默认「场景值」，可通过 /permission 覆盖

解析顺序：超级管理员（env, 3）-> KV 显式覆盖（0-3）-> 场景默认值。

- 私聊消息按群聊管理员（等级 1）处理。
- 群聊场景默认返回 GROUP_SCENE_LEVEL（默认 1）；开启 CHECK_GROUP_ADMIN 时，
  调用群成员接口识别真实群管。

## 命令系统

- 触发：群聊 @机器人 消息、私聊消息。
- 格式：/<command> [args]（参数可无可有多个；支持别名、描述、适用场景）。
- 权限由各 handler 用挡位比较自行判断。
- 反馈按场景自动发送（群聊 -> 群、私聊 -> 私聊），使用被动回复。

内置命令：
- /permission（别名 /perm）[<user_openid> [<0-3>|reset]]  （群聊/私聊，等级 3）
   - 无参：  返回你当前的场景权限
   - 1 参：  返回该用户当前的场景权限（含 KV 覆盖值）
   - 2 参：  把该用户权限设为 0-3；`reset` 清除覆盖，回到场景默认值
- /debug [args]   （群聊/私聊，等级 0）：回显原消息、参数、参数数量、用户 openid、
  用户权限、用户昵称

## 数据持久化（KV）

KV 绑定后以**全局变量 `LQBOT`** 暴露（不在 `env` 里；控制台绑定时的「变量名」必须设为 `LQBOT`）。
未绑定时 `storage.available === false`，所有持久化自动跳过，机器人仍可运行。

统一通过 `src/lib/storage.ts` 的命名空间化封装访问，实际 key 形如 `<namespace>:<key>`：

- `storage.global`（前缀 `bot:`）——跨模块基础设施：
  - `bot:app_access_token`：QQ access_token 缓存（`{access_token, expire_at}`）
  - `bot:seen`：最近 10 分钟内处理过的 msg_id 集合（单 key、写入时自动裁剪过期项并限长，避免 key 无限增长）
- `storage.ns('<模块>')`——各命令/模块自己的业务数据：
  - `perm:<user_openid>`：权限覆盖值 `0-3`（`/permission` 命令）

接口：`get / set / del / has / getJSON / setJSON`（`available` 标识 KV 是否绑定）。命令处理器只用
`ctx.cfg.storage`，不要直接访问全局 KV 变量；业务 key 走自己模块的命名空间。

权限覆盖可用 `/permission <user_openid> reset` 清除（回到场景默认值）。

## 新增命令

在 src/commands/ 下新建模块，导出下列字段，再 import 到 src/lib/registry.ts 的
commands 数组：
```typescript
import { LEVELS } from '../lib/permissions.js';
export const name = 'hello';          // 8个字以内
export const aliases = ['hi'];        // 8个字以内
export const description = '打招呼';   // 15个字以内
export const scenes = ['group', 'private'];
export const minLevel = LEVELS.USER;
export async function handler(ctx) {
  // ctx: { args, raw, original, scene, userOpenid, nick, level, reply, ... }
  await ctx.reply('hello, ' + (ctx.nick || 'friend'));
}
```
