先给项目起个名
要做一个severless的qq官方机器人服务，跑在edgeone边缘函数上，接收qq官方服务器的wenhook消息，通过fetch调用api发送消息，使用KV数据库持久化数据。
一、先搭框架：
1. 权限系统：
用户等级分为超级管理员(3)、全局管理员(2)、群聊管理员(1)、普通用户(0)，
超级管理员通过环境变量设置、全局管理员由超级管理员通过权限管理命令设置、群聊管理员和普通用户即字面意思（默认不用设置，自动根据场景获取，不落库，设置后覆盖场景值），
权限是挡位进阶关系，上一挡有下一档的所有权限。
2. 命令系统
命令触发方式有两种，群聊at消息和私聊消息（不考虑频道），私聊消息时权限同群聊管理员(1)
命令格式：/<command> [args]
参数可能没有或有多个，可以设置命令别名、描述、适用场景（群聊at消息和私聊消息），
命令权限由具体的命令处理器处理，命令反馈发在群里或者私聊中。
3. 内置命令：
权限管理命令，群聊at和私聊场景，权限3，/permission <user_openid> [int]
参数可为空，为空时返回用户当前场景的权限，为值时设置用户的权限
获取用户openid，群聊场景，权限3，/openid <user_name>
返回目标用户的openid
二、然后写一个测试命令：
群聊和私聊场景，权限0，/debug [args]
返回原消息、参数、参数数量、用户openid、用户权限、用户昵称
参考：
环境有edgeone全栈开发skill
qq官方机器人开发文档https://bot.q.qq.com/wiki/develop/api-v2/
edgeone边缘函数文档https://cloud.tencent.com/document/product/1552/127416
edgeone数据库文档https://cloud.tencent.com/document/product/1552/130378
