// QQ OpenAPI 客户端：换取 access_token、发送群/单聊消息、查询群成员。
// access_token 缓存在 KV（避免频繁换取，token 有效期通常 7200s）。
import type { Config, MemberInfo } from './types.js';
const TOKEN_KEY = 'bot:app_access_token';
export async function getAccessToken(cfg: Config): Promise<string> {
  if (cfg.kv) {
    try {
      const raw = await cfg.kv.get(TOKEN_KEY);
      if (raw) {
        const cached = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
        if (cached && cached.access_token && cached.expire_at && cached.expire_at > Date.now() + 60_000) {
          return cached.access_token;
        }
      }
    } catch (_) { /* 缓存不存在/损坏，忽略并重新获取 */ }
  }
  const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 同时带 appId 与 clientId：官方 v2 文档用 appId，部分旧文档/示例用 clientId，多带一个字段无害。
    body: JSON.stringify({ appId: cfg.appId, clientId: cfg.appId, clientSecret: cfg.appSecret }),
  });
  const text = await resp.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch (_) { data = {}; }
  if (!data.access_token) {
    throw new Error('getAppAccessToken 失败: ' + text);
  }
  const token = data.access_token;
  const expiresIn = Number(data.expires_in) || 7200;
  if (cfg.kv) {
    try {
      await cfg.kv.put(TOKEN_KEY, JSON.stringify({ access_token: token, expire_at: Date.now() + expiresIn * 1000 }));
    } catch (_) { /* 缓存写入失败不影响主流程 */ }
  }
  return token;
}
async function apiCall(cfg: Config, method: string, path: string, body?: unknown): Promise<any> {
  const token = await getAccessToken(cfg);
  const resp = await fetch(cfg.apiBase + path, {
    method,
    headers: {
      'Authorization': 'QQBot ' + token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  if (!resp.ok) {
    throw new Error('QQ API ' + method + ' ' + path + ' -> ' + resp.status + ': ' + text);
  }
  return data;
}
// 发送群消息（被动回复：传入消息 id 作为 msg_id）
export async function sendGroupMessage(cfg: Config, groupOpenid: string, content: string, msgId?: string): Promise<any> {
  const body: { content: string; msg_type: number; msg_id?: string } = { content, msg_type: 0 };
  if (msgId) body.msg_id = msgId;
  return apiCall(cfg, 'POST', '/v2/groups/' + encodeURIComponent(groupOpenid) + '/messages', body);
}
// 发送单聊消息（被动回复：传入消息 id 作为 msg_id）
export async function sendC2CMessage(cfg: Config, userOpenid: string, content: string, msgId?: string): Promise<any> {
  const body: { content: string; msg_type: number; msg_id?: string } = { content, msg_type: 0 };
  if (msgId) body.msg_id = msgId;
  return apiCall(cfg, 'POST', '/v2/users/' + encodeURIComponent(userOpenid) + '/messages', body);
}
// 获取群内单个成员详情：{ member_openid, user_openid, nick, role, ... }
export async function getGroupMember(cfg: Config, groupOpenid: string, memberOpenid: string): Promise<MemberInfo | null> {
  const data = await apiCall(cfg, 'GET',
    '/v2/groups/' + encodeURIComponent(groupOpenid) + '/members/' + encodeURIComponent(memberOpenid));
  return (data as MemberInfo) || null;
}
// 获取群成员列表（分页）。返回原始响应，由调用方兼容处理字段。
export async function listGroupMembers(cfg: Config, groupOpenid: string, limit?: number, after?: string): Promise<any> {
  const q = new URLSearchParams();
  if (limit) q.set('limit', String(limit));
  if (after) q.set('after', String(after));
  return apiCall(cfg, 'GET',
    '/v2/groups/' + encodeURIComponent(groupOpenid) + '/members' + (q.toString() ? '?' + q : ''));
}