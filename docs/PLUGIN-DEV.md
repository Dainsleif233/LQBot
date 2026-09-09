# 插件（命令）开发指南

面向给 LQBot 编写新命令（插件）的开发者。框架结构与关键约定见 [AGENTS.md](../AGENTS.md)。

## 1. 命令模块

在 `src/commands/` 新建模块，导出字段并以 `export default` 导出：

```typescript
// src/commands/hello.ts
import { LEVELS } from '../lib/permissions.js';
import type { Command, CommandContext, Scene } from '../lib/types.js';

export const name = 'hello';
export const aliases = ['hi'];          // 可选，最多 8 字
export const description = '打招呼';     // 最多 15 字
export const scenes: Scene[] = ['group', 'private'];
export const minLevel = LEVELS.USER;

export async function handler(ctx: CommandContext): Promise<void> {
  await ctx.reply('hello, ' + (ctx.nick || 'friend'));
}

const cmd: Command = { name, aliases, description, scenes, minLevel, handler };
export default cmd;
```

然后 import 到 `src/lib/registry.ts` 的 `commands` 数组，并执行 `npm run register` 同步指令面板。

## 2. 命令上下文（ctx）

| 字段 | 说明 |
| --- | --- |
| `name` / `args` / `raw` / `original` | 解析后的命令名、参数、原始文本 |
| `scene` | `'group'` / `'private'` |
| `userOpenid` / `memberOpenid` / `groupOpenid` | 发送者 / 成员 / 群 openid |
| `nick` | 昵称（可能为空） |
| `level` | 已解析的权限等级 0-3 |
| `memberInfo` | 群成员信息（可能为 null） |
| `event` / `messageId` | 原始事件、消息 id |
| `cfg` / `qq` | 配置、QQ 客户端 |
| `reply(content)` | 按场景被动回复 |
| `deny()` | 权限不足时的标准拒绝回复 |

## 3. 权限

- `minLevel`：挡位进阶（3>2>1>0）。`ctx.level >= minLevel` 才执行 handler，否则框架自动调用 `ctx.deny()`。
- 解析顺序：env 超管 → KV 覆盖（`perm:user:<openid>:level`）→ 场景默认。

## 4. 持久化（KV）

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

## 5. 指令面板

- 新增/修改命令后执行 `npm run register` 同步面板（先快照再重建，出错自动回滚）。
- 等级 < 3 → 全量面板（所有人可见）；等级 ≥ 3 → 仅私聊「管理员面板」（仅超管可见，内含全部命令）。

## 6. 调试

`/debug [args]`（等级 0）：回显原消息、参数、参数数量、用户 openid、用户权限、用户昵称。
