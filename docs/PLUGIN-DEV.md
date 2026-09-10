# 插件（命令）开发指南

面向给 LQBot 编写新命令（插件）的开发者。框架结构与关键约定见 [AGENTS.md](../AGENTS.md)。

## 1. 命令模块

在 `src/commands/` 新建模块，用 `defineCommand` 声明并以 `export default` 导出
（`aliases` 缺省为空、`scenes` 缺省群+私聊；`minLevel` 必填——显式声明权限，避免默认放开）：

```typescript
// src/commands/hello.ts
import { LEVELS } from '../lib/permissions.js';
import { defineCommand } from '../lib/define.js';
import type { CommandContext } from '../lib/types.js';

export default defineCommand({
  name: 'hello',            // ≤8 字；aliases ≤8 字；description ≤15 字
  aliases: ['hi'],
  description: '打招呼',
  minLevel: LEVELS.USER,
  async handler(ctx: CommandContext): Promise<void> {
    await ctx.reply('hello, ' + (ctx.nick || 'friend'));
  },
});
```

然后 import 到 `src/lib/registry.ts` 的 `commands` 数组，执行 `npm run register` 同步指令面板。
注意：具名导出（`export const name = …`）已不再被读取，只有 default 导出生效。

## 2. ctx 与权限

| 字段 | 说明 |
| --- | --- |
| `args` / `raw` / `original` | 参数、原始文本 |
| `sub` | 命中子命令链（多级空格连接如 `room create`；未命中 `null`） |
| `attachments` | 用户消息的富媒体附件 `contentType/filename/url/raw`（无则空数组） |
| `scene` / `userOpenid` / `memberOpenid` / `groupOpenid` / `nick` / `memberInfo` | 场景与发送者信息 |
| `level` | 已解析权限 0-3 |
| `event` / `messageId` / `cfg` / `qq` | 原始事件 / 消息 id / 配置 / 客户端 |
| `reply(text)` | 文本被动回复（群聊自动加换行分隔 @） |
| `replyMarkdown(md)` | Markdown 被动回复（msg_type=2） |
| `replyMedia(type, url)` | 富媒体被动回复：URL 上传拿 `file_info` 后发送（msg_type=7） |
| `deny()` | 权限不足标准拒绝回复 |

权限：挡位 3>2>1>0，`ctx.level >= minLevel` 才执行，否则框架自动 `deny()`（拒绝会指明路径与所需等级）。
等级解析：env 超管 → KV 覆盖 `perm:user:<openid>:level` → 场景默认。

## 3. 子命令（支持多级）

```typescript
export default defineCommand({
  name: 'game',
  description: '游戏',
  minLevel: LEVELS.USER,                      // /game 本体：等级 0
  // 主 handler 可省略：省略时 /game 自动回复子命令用法
  subcommands: [
    { name: 'add', aliases: ['new'], description: '添加一局游戏',
      minLevel: LEVELS.GLOBAL_ADMIN,          // /game add：等级 2（覆盖主命令的 0）
      async handler(ctx) { /* ctx.args 已去掉 'add' */ } },
    { name: 'room', description: '房间管理',   // 分组节点：省略 handler 自动回用法
      subcommands: [
        { name: 'create', description: '创建房间', minLevel: LEVELS.GLOBAL_ADMIN,
          async handler(ctx) { /* /game room create */ } },
      ] },
  ],
});
```

- 多级逐级匹配（`/game room create`）；中间节点省略 handler 时进入即自动回复子命令用法。
- 权限沿路径继承：子节点未设 `minLevel` 继承父级生效等级，设置了则覆盖。
- 未命中的参数原样传给已匹配的最深节点（`/game foo` → 主 handler，`args=['foo']`）。
- 面板暂不注册子命令（元素名不建议带空格）。

## 4. 持久化（KV）

走 `ctx.cfg.storage`（勿碰全局变量 `LQBOT`）。命名空间（模块隔离）× 作用域两级：

| 作用域 | 访问方式 | 实际 key |
| --- | --- | --- |
| 全局 | `ns.global` | `<ns>:global:<key>` |
| 群聊场景 | `ns.group(gid)` / `ns.scene(ctx)` | `<ns>:group:<group_openid>:<key>` |
| 用户场景 | `ns.user(uid)` / `ns.scene(ctx)` | `<ns>:user:<user_openid>:<key>` |

```typescript
const ns = ctx.cfg.storage.ns('hello');      // 本命令命名空间
if (!ns.available) { await ctx.reply('KV 未绑定'); return; }   // 读恒 null、写/删静默跳过
await ns.global.set('total', '1');           // hello:global:total
const scene = ns.scene(ctx);                 // 自动选群/用户；openid 缺失返回 null
if (scene) await scene.set('count', '1');    // hello:group:<gid>:count
await ns.user(ctx.userOpenid)?.setJSON('profile', { nick: ctx.nick });
```

存取器：`get/set`（字符串）、`getJSON/setJSON`（对象）、`has`、`del`、`available`、`namespace`。

约定：只用自己模块的命名空间（`storage.infra` 前缀 `bot:` 是基础设施，别放业务数据）；KV 未绑定先判
`available`；值都是字符串，对象走 `setJSON/getJSON`。现有 key：`bot:global:app_access_token`（token）、
`bot:global:seen`（去重）、`perm:user:<openid>:level`（权限）。

## 5. Markdown / 富媒体 / 附件

| 方法 | 行为 |
| --- | --- |
| `ctx.reply(text)` | 文本（msg_type=0，群聊自动加换行） |
| `ctx.replyMarkdown(md)` | Markdown（msg_type=2）：标题/加粗/链接/图片(公网 URL)/列表/引用 |
| `ctx.replyMedia(type, url)` | URL 上传拿 `file_info`（`srv_send_msg=false`）→ msg_type=7 发送 |

`type`：1 图片(jpg/png，软限 20MB) / 2 视频(mp4，30MB) / 3 语音(silk) / 4 文件(任意，200MB)。

```typescript
await ctx.replyMarkdown('# 战报\n- 第一名：**张三**');
await ctx.replyMedia(1, 'https://example.com/result.png');
```

注意：

- Markdown 已全量开放（无需申请模板）；**单聊只发不收，群聊收发**。
- `file_info` **单聊/群聊隔离**、有效期 `ttl`（秒，**0=长期**）；`replyMedia` 随用随传不缓存。
- 上传 `url` 仅接受 http(s)://（`data:`/本地路径 fail-fast）；固定 `srv_send_msg=false` 不占主动额度。
- 一个事件被动回复次数有限（单聊 4 次 / 群聊 5 次，含错误兜底回复），先规划总条数。
- **SVG 不支持**（实测）：当图片被拒（40034002）、当文件可发（文件卡片）、MD 内嵌不渲染——先转 PNG/JPG。

接收侧：用户发来的媒体在 `ctx.attachments`；**其 `url` 可能为 base64 data URL，files 只收 http(s)——「收到即转发」做不到**，需自行转存公网地址（分片上传待支持）。

## 6. 面板与调试

- 新增/修改命令后 `npm run register` 同步面板（快照→重建→出错回滚）；等级 <3 全量面板（所有人），≥3 仅私聊管理员面板（仅超管）。
- `/debug [args]`（等级 0）回显消息/参数/openid/权限/昵称，排查插件入参最快。
