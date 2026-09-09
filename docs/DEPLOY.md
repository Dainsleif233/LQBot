# 部署与配置

## 部署步骤

1. Fork 本仓库。
2. 在 EdgeOne Makers 控制台以「导入 Git 仓库」方式创建项目（选择你 Fork 的仓库）。
3. 配置项目环境变量：`APP_ID` / `APP_SECRET`（QQ 机器人凭证）、`SUPER_ADMIN_OPENID`（等级 3 用户 openid，可用 `/debug` 获取）等。
   事件验签默认**开启**（`VERIFY_EVENT_SIGNATURE=false` 关闭）；单独配置了 `WEBHOOK_SECRET` 时验签用它、换 token 仍用 `APP_SECRET`。
   本地调试可复制 `.env.example` 为 `.env`。
4. 开始部署（导入后自动构建；之后更新仓库会自动重新部署）。
5. 开通 KV 并绑定命名空间到项目：EdgeOne Makers 控制台 → KV 存储 → 申请/创建命名空间 → 绑定，
   **变量名设为 `LQBOT`**（绑定名即代码里的全局变量名，必须一致；不改则持久化自动跳过）。
6. 配置域名和证书。
7. 配置 QQ 机器人回调地址：QQ 机器人运营与管理后台「开发设置 → 事件订阅与回调」，接入方式选「Webhook」，回调地址填 `https://<你的边缘域名>/webhook`；接收事件配置选「部分接收」，勾选「C2C消息事件」、「群消息事件 AT 事件」；
   平台会先发 op=13 地址校验，本服务用 `APP_SECRET`（或 `WEBHOOK_SECRET`）派生 Ed25519 私钥自动签名通过。

### 本地开发（可选）

`PAGES_SOURCE=skills edgeone makers dev -n LQBot`（访问 http://127.0.0.1:8088/）；
CLI 部署：`PAGES_SOURCE=skills edgeone makers deploy -n LQBot`。

## 权限系统

用户等级（挡位进阶，高等级拥有低等级全部权限）：

    Level 3  超级管理员   来自环境变量 SUPER_ADMIN_OPENID
    Level 2  全局管理员   由超级管理员通过 /permission 设置
    Level 1  群聊管理员   默认「场景值」，可通过 /permission 覆盖
    Level 0  普通用户     默认「场景值」，可通过 /permission 覆盖

解析顺序：超级管理员（env, 3）→ KV 显式覆盖（0-3）→ 场景默认值。

- 私聊消息按群聊管理员（等级 1）处理。
- 群聊默认返回 `GROUP_SCENE_LEVEL`（默认 1）；开启 `CHECK_GROUP_ADMIN` 时按群成员 role 识别真实群管。

## 命令系统与内置命令

- 触发：群聊 @机器人 消息、私聊消息；格式 `/<command> [args]`（支持别名、描述、适用场景）。
- 权限由各 handler 用挡位比较判断（`level >= minLevel` 通过，否则 `ctx.deny()`）。
- 反馈按场景自动被动回复（群聊 → 群、私聊 → 私聊）。

内置命令：

- `/permission`（别名 `/perm`）`[<user_openid> [<0-3>|reset]]`（群聊/私聊，等级 3）
  - 无参：返回你当前的场景权限
  - 1 参：返回该用户当前的场景权限（含 KV 覆盖值）
  - 2 参：把该用户权限设为 0-3；`reset` 清除覆盖，回到场景默认值
- `/debug [args]`（群聊/私聊，等级 0）：回显原消息、参数、参数数量、用户 openid、用户权限、用户昵称

## 指令面板（命令菜单）同步

`npm run register` 把 `src/commands/` 下的命令（含别名）同步为 QQ 机器人「指令面板」，用户可在聊天框一键触发。

- 数据源与命令系统同源，直接读取命令模块的 `name / aliases / description / minLevel`，无需手维护清单。
- 等级 < 3 → 「全量面板」（群聊 + 私聊，所有人可见）；等级 ≥ 3 → 只在**私聊**的「管理员面板」按
  `user_openids=[SUPER_ADMIN_OPENID]` 限定给超级管理员（群聊面板不支持按用户限定，故不注册）。
  管理员面板内含**全部命令**：QQ 对被 specific 面板命中的用户可能只展示该面板、隐藏 all 面板，
  这样超管在私聊也能看到 `/debug` 等通用命令。
- 对账式同步：先快照现有面板 → 删除 → 按当前命令重建；任一步出错则自动回滚还原原面板。
- 面板元素 `name` 不带 `/`、别名各自注册；接口 **10 QPM**、每机器人最多 20 个面板、元素 `desc` ≤ 30 字符。
- `npm start` = `npm run register && npm run deploy`。
