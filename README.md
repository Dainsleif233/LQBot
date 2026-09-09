# LQBot

运行在 EdgeOne 边缘函数上的无服务器 QQ 官方机器人框架。

- 接收 QQ 官方服务器 Webhook
- 通过 QQ OpenAPI 发送消息
- KV 持久化
- 挡位权限系统 + 插件式命令系统

## 部署

1. Fork 本仓库
2. 在 EdgeOne Makers 中以「导入 Git 仓库」方式创建项目
3. 配置项目环境变量
4. 开始部署
5. 开通 KV 并绑定命名空间到项目，变量名设为 `LQBOT`
6. 配置域名和证书
7. 配置 QQ 机器人回调地址

详细步骤与配置项见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署与配置、权限系统、命令系统与内置命令、指令面板同步 |
| [docs/PLUGIN-DEV.md](docs/PLUGIN-DEV.md) | 插件（命令）开发：命令模块、上下文、权限、持久化、面板 |
| [AGENTS.md](AGENTS.md) | 面向智能体协助开发**框架**的架构约定与坑位 |
| [docs/SUMMARY.md](docs/SUMMARY.md) | 项目搭建过程总结 |
