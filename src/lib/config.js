// 运行时配置：从环境变量构建（每次请求重建，因为 env 是 per-request 的）
// 注意：my_kv 是 EdgeOne 绑定后的全局变量，不在 env 里，这里通过 globalThis 安全获取。

export function createConfig(env) {
  env = env || {};
  return {
    // QQ 机器人 AppID / AppSecret（用于换取 access_token 与 webhook 签名）
    appId: env.APP_ID || '',
    appSecret: env.APP_SECRET || env.WEBHOOK_SECRET || '',

    // QQ OpenAPI 基地址（沙箱可用 https://sandbox.api.sgroup.qq.com）
    apiBase: (env.QQ_API_BASE || 'https://api.sgroup.qq.com').replace(/\/+$/, ''),

    // 超级管理员（环境变量设置，等级 3）。填写用户的 user_openid。
    superAdminOpenid: env.SUPER_ADMIN_OPENID || '',

    // 是否校验每次回调的 Ed25519 签名（默认关，开启更安全）。
    verifyEventSignature: env.VERIFY_EVENT_SIGNATURE === 'true',

    // 群聊场景是否调用成员接口检测真实群管身份（默认开）。
    // 关闭时群聊场景一律按 groupSceneLevel 返回（见下）。
    checkGroupAdmin: env.CHECK_GROUP_ADMIN !== 'false',

    // 群聊场景的默认等级（"群聊管理员"场景值），默认 1。
    groupSceneLevel: (env.GROUP_SCENE_LEVEL !== undefined && env.GROUP_SCENE_LEVEL !== '')
      ? parseInt(env.GROUP_SCENE_LEVEL, 10)
      : 1,

    // KV 命名空间（绑定后才有）。未绑定则为 null，持久化相关功能会被跳过。
    kv: (typeof globalThis !== 'undefined' && globalThis.my_kv) ? globalThis.my_kv : null,
  };
}
