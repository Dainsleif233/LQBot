# 插件（命令）开发指南

面向给 LQBot 编写新命令（插件）的开发者。框架结构与关键约定见 [AGENTS.md](../AGENTS.md)。

## 1. 命令模块

在 `src/commands/` 新建模块，用 `defineCommand` 声明并以 `export default` 导出
（`aliases` 缺省为空、`scenes` 缺省为群+私聊；`minLevel` 必填，显式声明权限避免默认放开）：

```typescript
// src/commands/hello.ts
import { LEVELS } from '../lib/permissions.js';
import { defineCommand } from '../lib/define.js';
import type { CommandContext } from '../lib/types.js';

export default defineCommand({
  name: 'hello',
  aliases: ['hi'],
  description: '打招呼',
  minLevel: LEVELS.USER,
  async handler(ctx: CommandContext): Promise<void> {
    await ctx.reply('hello, ' + (ctx.nick || 'friend'));
  },
});
```

然后 import 到 `src/lib/registry.ts` 的 `commands` 数组，并执行 `npm run register` 同步指令面板。
注意：具名导出（`export const name = …`）已不再被读取，只有 default 导出生效。

## 2. 命令上下文（ctx）

| 字段 | 说明 |
| --- | --- |
| `name` / `args` / `raw` / `original` | 解析后的命令名、参数、原始文本 |
| `sub` | 命中的子命令链（多级以空格连接，如 'room create'；未命中子命令时为 `null`） |
| `attachments` | 用户消息携带的富媒体附件（`contentType`/`filename`/`url`/`raw`；无则空数组） |
| `scene` | `'group'` / `'private'` |
| `userOpenid` / `memberOpenid` / `groupOpenid` | 发送者 / 成员 / 群 openid |
| `nick` | 昵称（可能为空） |
| `level` | 已解析的权限等级 0-3 |
| `memberInfo` | 群成员信息（可能为 null） |
| `event` / `messageId` | 原始事件、消息 id |
| `cfg` / `qq` | 配置、QQ 客户端 |
| `reply(content)` / `replyMarkdown(md)` / `replyMedia(type, url)` | 文本 / Markdown（msg_type=2）/ 富媒体（msg_type=7）被动回复 |
| `deny()` | 权限不足时的标准拒绝回复 |

## 3. 权限

- `minLevel`：挡位进阶（3>2>1>0）。`ctx.level >= minLevel` 才执行 handler，否则框架自动调用 `ctx.deny()`。
- 解析顺序：env 超管 → KV 覆盖（`perm:user:<openid>:level`）→ 场景默认。

## 4. 子命令（可选）

一个命令可以声明子命令，让 `/game add` 这类形式**单独设置权限，覆盖主命令的 minLevel**：

```typescript
// src/commands/game.ts
import { LEVELS } from '../lib/permissions.js';
import { defineCommand } from '../lib/define.js';
import type { CommandContext } from '../lib/types.js';

export default defineCommand({
  name: 'game',
  description: '游戏',
  minLevel: LEVELS.USER,             // /game 本体：等级 0
  // 主 handler 可省略：省略时 /game 自动回复子命令用法列表
  async handler(ctx: CommandContext): Promise<void> {
    await ctx.reply('用法：/game add <name> | /game room');
  },
  subcommands: [
    {
      name: 'add',
      aliases: ['new'],
      description: '添加一局游戏',
      minLevel: LEVELS.GLOBAL_ADMIN, // /game add：等级 2（覆盖主命令的 0）
      async handler(ctx: CommandContext): Promise<void> {
        // ctx.sub === 'add'；ctx.args 已去掉子命令名
        await ctx.reply('添加游戏：' + ctx.args.join(' '));
      },
    },
    {
      name: 'room',                  // 分组节点：省略 handler，/game room 自动回用法
      description: '房间管理',
      subcommands: [
        {
          name: 'create',
          description: '创建房间',
          minLevel: LEVELS.GLOBAL_ADMIN, // /game room create：等级 2
          async handler(ctx: CommandContext): Promise<void> {
            await ctx.reply('创建房间：' + ctx.args.join(' '));
          },
        },
      ],
    },
  ],
});
```

规则：

- **多级匹配**：`/game room create` 逐级向下匹配已声明的子命令；中间节点（如 `room`）可省略
  `handler`，此时进入该节点会**自动回复其子命令用法**（如 `用法：/game room` + 子命令列表）。
- **权限沿路径继承**：子节点未设置 `minLevel` 时继承父级生效等级；设置了则覆盖（可为任意 0-3 值）。
- 只有**声明过的**子命令会命中（`/game foo` 未命中 → 从已匹配的最深节点继续，未匹配参数原样传入）。
- 命中时：`ctx.sub` = 命中链（多级用空格连接，如 `room create`），`ctx.args` 为剩余参数。
- 拒绝回复会指明完整路径与所需等级（如 `权限不足：game add 需要等级 2…`）。
- 指令面板暂不注册子命令（QQ 面板元素名不建议带空格）。

## 5. 持久化（KV）

命令通过 **`ctx.cfg.storage`** 访问 KV，**不要**直接访问全局变量 `LQBOT`。存储分两级作用域：

- **全局变量**：整个机器人共享同一份值
- **场景变量**：按群聊 openid / 用户 openid 隔离，不同 openid 的值互不影响

```typescript
export async function handler(ctx: CommandContext): Promise<void> {
  const ns = ctx.cfg.storage.ns('hello');   // 本命令的命名空间
  if (!ns.available) {                      // KV 未绑定：读恒 null、写/删静默跳过
    await ctx.reply('KV 未绑定，无法记录。');
    return;
  }

  // 全局变量（整个机器人共享）-> hello:global:total
  const total = Number((await ns.global.get('total')) || 0) + 1;
  await ns.global.set('total', String(total));

  // 场景变量（按当前场景自动选群聊/用户）-> hello:group:<gid>:count 或 hello:user:<uid>:count
  const scene = ns.scene(ctx);
  const count = scene ? Number((await scene.get('count')) || 0) + 1 : 0;
  if (scene) await scene.set('count', String(count));

  // 也可显式指定：ns.group(ctx.groupOpenid) / ns.user(ctx.userOpenid)
  const user = ns.user(ctx.userOpenid);     // openid 为空时返回 null
  if (user) await user.setJSON('profile', { nick: ctx.nick, at: Date.now() });

  await ctx.reply('本会话第 ' + count + ' 次，全局第 ' + total + ' 次');
}
```

key 结构：

| 作用域 | 访问方式 | 实际 key |
| --- | --- | --- |
| 全局变量 | `ns.global` | `<命名空间>:global:<key>` |
| 群聊场景 | `ns.group(gid)` / `ns.scene(ctx)` | `<命名空间>:group:<group_openid>:<key>` |
| 用户场景 | `ns.user(uid)` / `ns.scene(ctx)` | `<命名空间>:user:<user_openid>:<key>` |

存取器接口（`ns.global` / `ns.group()` / `ns.user()` / `ns.scene()` 返回的 `store`）：

| 方法 | 说明 |
| --- | --- |
| `store.get(key)` / `store.set(key, value)` | 读写字符串（读不存在返回 `null`） |
| `store.getJSON<T>(key)` / `store.setJSON(key, value)` | 读写对象（自动 JSON 序列化/反序列化） |
| `store.has(key)` / `store.del(key)` | 是否存在 / 删除 |
| `store.available` / `store.namespace` | KV 是否绑定 / 所属命名空间 |

约定：

- **命名空间隔离**：`storage.ns('<命令名>')` 只读写自己的命名空间；`storage.infra`（前缀 `bot:`）是基础设施命名空间（token 缓存、消息去重），业务数据不要放。
- **场景变量要判空**：`ns.group(gid)` / `ns.user(uid)` / `ns.scene(ctx)` 在 openid 缺失时返回 `null`。
- **未绑定 KV**：先判 `ns.available`（或 `store.available`）再决定是否提示；读操作本身不会抛错。
- **值都是字符串**：对象/数组请用 `setJSON` / `getJSON`。
- 当前已有的 key：`bot:global:app_access_token`（token 缓存）、`bot:global:seen`（消息去重）、`perm:user:<openid>:level`（权限覆盖）。

## 6. Markdown 与富媒体回复

| 方法 | 行为 |
| --- | --- |
| `ctx.reply(content)` | 文本（msg_type=0，群聊开头自动加换行） |
| `ctx.replyMarkdown(content)` | Markdown（msg_type=2，body `markdown: { content }`） |
| `ctx.replyMedia(fileType, url)` | 先 URL 上传拿 `file_info`（`srv_send_msg=false`），再富媒体发送（msg_type=7） |

`fileType`：`1` 图片(jpg/png，软限 20MB) / `2` 视频(mp4，软限 30MB) / `3` 语音(silk) / `4` 文件(任意，软限 200MB)。

示例：

```typescript
await ctx.replyMarkdown('# 战报\n- 第一名：**张三**');
await ctx.replyMedia(1, 'https://example.com/result.png');   // 图片
await ctx.replyMedia(4, 'https://example.com/report.pdf');   // 文件
```

注意：

- Markdown 已对所有机器人开放（无需申请模板）；**单聊只发不收，群聊收发均支持**。
- 富媒体上传接口**单聊/群聊相互隔离**，`file_info` 不能跨场景复用，有效期为 `ttl`（秒，**0=可长期使用**）——`replyMedia` 随用随传、不缓存。
- 上传固定 `srv_send_msg=false`（不占每月 4 条主动消息额度，被动窗口内正常携带 msg_id）。
- 上传 `url` 必须以 http(s):// 开头（`uploadFile` 会先校验），`data:` 或本地路径会被 QQ 拒且报错含义模糊。
- 一个事件内的被动回复次数有限（单聊 4 次 / 群聊 5 次，含错误兜底回复），写 handler 前先规划好总回复条数。
- 语音格式文档有出入（概览写 silk/mp3/wav/ogg，file_type 表写 silk），以平台实测为准。
- **SVG 不支持**（实测）：当图片（fileType 1）会被拒（40034002「富媒体文件格式不支持」），当文件（fileType 4）可发（文件卡片）；Markdown 内嵌 SVG 不渲染。需要发 SVG 时先转成 PNG/JPG。

接收侧：用户发来的图片/视频/语音/文件在 **`ctx.attachments`**（`contentType` / `filename` / `url` / `raw`，字段名已容错归一化）；消息无文本时不会触发命令，插件可在有文本的命令里读取 `ctx.attachments`。
注意：附件里的 `url` 可能为 base64 data URL（平台下发实测），而 files 上传接口仅接受 http(s) URL——**「收到即转发」当前做不到**，需自行转存到公网地址（或等待分片上传支持）。

## 7. 指令面板

- 新增/修改命令后执行 `npm run register` 同步面板（先快照再重建，出错自动回滚）。
- 等级 < 3 → 全量面板（所有人可见）；等级 ≥ 3 → 仅私聊「管理员面板」（仅超管可见，内含全部命令）。

## 8. 调试

`/debug [args]`（等级 0）：回显原消息、参数、参数数量、用户 openid、用户权限、用户昵称。
