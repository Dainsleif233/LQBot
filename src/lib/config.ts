// 运行时配置：从环境变量构建（每次请求重建，因为 env 是 per-request 的）
// 注意：KV 绑定后作为全局变量 LQBOT 暴露（不在 env 里），这里通过 globalThis 安全获取并包成 storage。
import type { Config, KVLike } from './types.js';
import { createStorage } from './storage.js';
export function createConfig(env: Record<string, string | undefined> | undefined): Config {
  env = env || {};
  // KV 命名空间：控制台绑定时的「变量名」即此全局变量名（LQBOT）。未绑定则为 null。
  const rawKv = (typeof globalThis !== 'undefined' && (globalThis as any).LQBOT)
    ? ((globalThis as any).LQBOT as KVLike)
    : null;
  return {
    // QQ 机器人 AppID / AppSecret（用于换取 access_token 与 webhook 签名）
    appId: env.APP_ID || '',
    appSecret: env.APP_SECRET || env.WEBHOOK_SECRET || '',
    // QQ OpenAPI 基地址（官方 2026-08-10 起统一为 https://api.bot.qq.com；沙箱可用 https://sandbox.api.sgroup.qq.com）
    apiBase: (env.QQ_API_BASE || 'https://api.bot.qq.com').replace(/\/+$/, ''),
    // 超级管理员（环境变量设置，等级 3）。填写用户的 user_openid。
    superAdminOpenid: env.SUPER_ADMIN_OPENID || '',
    // 是否校验每次回调的 Ed25519 签名（默认关，开启更安全）。
    verifyEventSignature: env.VERIFY_EVENT_SIGNATURE === 'true',
    // 群聊场景是否调用成员接口检测真实群管身份（默认开）。
    checkGroupAdmin: env.CHECK_GROUP_ADMIN !== 'false',
    // 群聊场景的默认等级（"群聊管理员"场景值），默认 1。
    groupSceneLevel: (env.GROUP_SCENE_LEVEL !== undefined && env.GROUP_SCENE_LEVEL !== '')
      ? parseInt(env.GROUP_SCENE_LEVEL, 10)
      : 1,
    // 持久化入口（命名空间化封装）。KV 未绑定时 storage.available === false，相关功能自动跳过。
    storage: createStorage(rawKv),
  };
}
