# LQBot —— 跑在 EdgeOne 边缘函数上的无服务器 QQ 官方机器人

一个运行在 EdgeOne 边缘函数上的 QQ 官方机器人服务：

- 接收 QQ 官方服务器的 Webhook 推送（群聊 @消息、私聊消息）
- 通过 QQ OpenAPI（fetch）发送消息
- 使用 KV 数据库持久化数据（权限等）
- 内置挡位权限系统与插件式命令系统

不考虑频道（Guild）场景。

## 目录结构

    LQBot/
      edge-functions/            # 仅对外暴露的接口
        api/webhook.ts       入口：POST /api/webhook
      src/                     # 全部内部模块（由边缘构建打包进函数）
        lib/
          config.ts           从环境变量构建运行时配置
          crypto.ts           Webhook 的 Ed25519 签名/验签（地址校验 + 事件校验）
          tweetnacl.js        vendored 纯 JS Ed25519（边缘运行时缺 WebCrypto Ed25519）
          qq.ts               QQ OpenAPI 客户端（token / 发消息 / 群成员）
          permissions.ts      权限解析（3>2>1>0，挡位进阶）
          registry.ts         命令注册与解析
          reply.ts            按场景回复（群聊 / 私聊）
          handler.ts          Webhook 主逻辑（验签 / 分发 / 执行）
        commands/
          permission.ts       /permission  权限管理（等级 3）
          openid.ts           /openid      按昵称查 openid（等级 3，仅群聊）
          test.ts             /test        测试命令（等级 0）
      .env.example
      package.json
      README.md

## 部署与配置

1. 开通 KV 存储并绑定命名空间
   - EdgeOne Makers 控制台 -> KV 存储 -> 申请 -> 创建命名空间
   - 绑定到本项目，变量名设为 my_kv（代码里作为全局变量 my_kv 访问）

2. 配置环境变量
   - 本地：复制 .env.example 为 .env；或在 Makers 控制台设置：
     APP_ID / APP_SECRET（QQ 机器人凭证）、SUPER_ADMIN_OPENID（等级 3 用户 openid）等

3. 本地开发

    npm install -g edgeone
    PAGES_SOURCE=skills edgeone makers dev -n LQBot
    # 打开 http://127.0.0.1:8088/

4. 部署

    PAGES_SOURCE=skills edgeone makers deploy -n LQBot

5. 配置 QQ 回调地址
   - 在 QQ 开放平台「开发设置 -> 回调地址」填写：https://<你的边缘域名>/api/webhook
   - 平台先发 op=13 地址校验。本服务用 APP_SECRET（或 WEBHOOK_SECRET）派生 Ed25519
     私钥，对 event_ts + plain_token 签名并返回，自动通过校验。

## 权限系统

用户等级（挡位进阶，高等级拥有低等级全部权限）：

    Level 3  超级管理员   来自环境变量 SUPER_ADMIN_OPENID
    Level 2  全局管理员   由超级管理员通过 /permission 设置（落 KV）
    Level 1  群聊管理员   默认「场景值」，可通过 /permission 覆盖
    Level 0  普通用户     默认「场景值」，可通过 /permission 覆盖

解析顺序：超级管理员（env, 3）-> KV 显式覆盖（0-3）-> 场景默认值。

- 私聊消息按群聊管理员（等级 1）处理。
- 群聊场景默认返回 GROUP_SCENE_LEVEL（默认 1）；开启 CHECK_GROUP_ADMIN 时，
  调用群成员接口识别真实群管（role 命中 -> 1，否则 0）。
- 「群管/普通用户按场景自动获取、不落库、设置后覆盖场景值」正对应上面的
  场景默认 + KV 覆盖机制。

## 命令系统

- 触发：群聊 @机器人 消息、私聊消息。
- 格式：/<command> [args]（参数可无可有多个；支持别名、描述、适用场景）。
- 权限由各 handler 用挡位比较自行判断。
- 反馈按场景自动发送（群聊 -> 群、私聊 -> 私聊），使用被动回复（携带事件消息 id）。

内置命令：
- /permission [<user_openid> [<int>]]  （群聊/私聊，等级 3）
    - 无参：  返回你当前的场景权限
    - 1 参：  返回该用户当前的场景权限（含 KV 覆盖值）
    - 2 参：  把该用户权限设为 0-3
- /openid <昵称>  （仅群聊，等级 3）：在群成员列表中按昵称匹配，返回 openid
- /test [args]    （群聊/私聊，等级 0）：回显原消息、参数、参数数量、用户 openid、
  用户权限、用户昵称

## 新增命令

在 src/commands/ 下新建模块，导出下列字段，再 import 到 src/lib/registry.ts 的
commands 数组：

    import { LEVELS } from '../lib/permissions.js';
    export const name = 'hello';
    export const aliases = ['hi'];
    export const description = '打招呼';
    export const scenes = ['group', 'private'];
    export const minLevel = LEVELS.USER;
    export async function handler(ctx) {
      // ctx: { args, raw, original, scene, userOpenid, nick, level, reply, ... }
      await ctx.reply('hello, ' + (ctx.nick || 'friend'));
    }

## 已知坑位（部分官方文档未完全开放，按需校准）

- 群成员接口：GET /v2/groups/{group_openid}/members 的返回结构（尤其 role / nick
  字段）官方未完整文档化。代码已做兼容；若实测字段不同，调整
  commands/openid.ts 的 normalizeMembers 与 lib/permissions.ts 的 isGroupAdminRole。
- 被动回复窗口：群 5 分钟、私聊 60 分钟；超出后只能用主动消息（每月配额）。
- Ed25519：Webhook 签名依赖 Ed25519，但边缘运行时的 WebCrypto 不支持该算法
  （实测 importKey/sign 均报 Param Invalid），因此项目 vendored 了纯 JS 的
  tweetnacl 来完成签名。
