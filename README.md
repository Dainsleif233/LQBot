# LQBot

一个运行在 EdgeOne 边缘函数上的 QQ 官方机器人框架

- 接收 QQ 官方服务器 Webhook（群聊 @消息、私聊消息）
- 通过 QQ OpenAPI（fetch）发送消息
- KV 持久化（全局变量 + 场景变量，按模块命名空间隔离）
- 挡位权限系统（3>2>1>0）+ 插件式命令系统

## 项目结构

```text
LQBot/
├── edge-functions/webhook.ts   # POST /webhook 入口
├── src/lib/                    # 框架内部：配置 / 存储 / 签名 / QQ 客户端 / 权限 / 命令注册 / 回复 / 主逻辑
├── src/commands/               # 命令模块：permission.ts、debug.ts
├── scripts/register.ts         # 指令面板同步（npm run register）
└── docs/SUMMARY.md
```

> 各文件职责与关键约定见 [AGENTS.md](AGENTS.md)。

## 部署与配置

1. 开通 KV 并绑定命名空间：EdgeOne Makers 控制台 → KV 存储 → 申请/创建命名空间 → 绑定到本项目，
   **变量名设为 `LQBOT`**（绑定名即代码里的全局变量名，必须一致；不改则持久化自动跳过）。
2. 配置环境变量：复制 `.env.example` 为 `.env`，或直接在控制台设置
   `APP_ID` / `APP_SECRET`（QQ 机器人凭证）、`SUPER_ADMIN_OPENID`（等级 3 用户 openid，可用 `/debug` 获取）等。
3. 本地开发：`PAGES_SOURCE=skills edgeone makers dev -n LQBot`（访问 http://127.0.0.1:8088/）
4. 部署：`PAGES_SOURCE=skills edgeone makers deploy -n LQBot`
5. 配置 QQ 回调地址：QQ 开放平台「开发设置 → 回调地址」填 `https://<你的边缘域名>/webhook`；
   平台会先发 op=13 地址校验，本服务用 `APP_SECRET`（或 `WEBHOOK_SECRET`）派生 Ed25519 私钥自动签名通过。

## 指令面板（命令菜单）同步

`npm run register` 把 `src/commands/` 下的命令（含别名）同步为 QQ 机器人「指令面板」，用户可在聊天框一键触发。

- 数据源与命令系统同源，直接读取命令模块的 `name / aliases / description / minLevel`，无需手维护清单。
- 等级 < 3 → 「全量面板」（群聊 + 私聊，所有人可见）；等级 ≥ 3 → 只在**私聊**面板按
  `user_openids=[SUPER_ADMIN_OPENID]` 限定给超级管理员（群聊面板不支持按用户限定，故不注册）。
- 对账式同步：先快照现有面板 → 删除 → 按当前命令重建；任一步出错则自动回滚还原原面板。
- 面板元素 `name` 不带 `/`、别名各自注册；接口 **10 QPM**、每机器人最多 20 个面板、元素 `desc` ≤ 30 字符。
- `npm start` = `npm run register && npm run deploy`。

## 权限系统

用户等级（挡位进阶，高等级拥有低等级全部权限）：

    Level 3  超级管理员   来自环境变量 SUPER_ADMIN_OPENID
    Level 2  全局管理员   由超级管理员通过 /permission 设置
    Level 1  群聊管理员   默认「场景值」，可通过 /permission 覆盖
    Level 0  普通用户     默认「场景值」，可通过 /permission 覆盖

解析顺序：超级管理员（env, 3）→ KV 显式覆盖（0-3）→ 场景默认值。

- 私聊消息按群聊管理员（等级 1）处理。
- 群聊默认返回 `GROUP_SCENE_LEVEL`（默认 1）；开启 `CHECK_GROUP_ADMIN` 时按群成员 role 识别真实群管。

## 命令系统

- 触发：群聊 @机器人 消息、私聊消息；格式 `/<command> [args]`（支持别名、描述、适用场景）。
- 权限由各 handler 用挡位比较判断（`level >= minLevel` 通过，否则 `ctx.deny()`）。
- 反馈按场景自动被动回复（群聊 → 群、私聊 → 私聊）。

内置命令：

- `/permission`（别名 `/perm`）`[<user_openid> [<0-3>|reset]]`（群聊/私聊，等级 3）
  - 无参：返回你当前的场景权限
  - 1 参：返回该用户当前的场景权限（含 KV 覆盖值）
  - 2 参：把该用户权限设为 0-3；`reset` 清除覆盖，回到场景默认值
- `/debug [args]`（群聊/私聊，等级 0）：回显原消息、参数、参数数量、用户 openid、用户权限、用户昵称

## 新增命令

**第 1 步**：在 `src/commands/` 新建模块，导出字段并以 `export default` 导出。

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

**第 2 步**：import 到 `src/lib/registry.ts` 的 `commands` 数组，然后执行 `npm run register` 同步指令面板。

### 在命令里使用持久化（KV）

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
