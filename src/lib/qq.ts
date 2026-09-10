// QQ OpenAPI 客户端：换取 access_token、发送文本/Markdown/富媒体、查询群成员。
// access_token 缓存在 KV（避免频繁换取，token 有效期通常 7200s）。
import type { Config, MediaType, MemberInfo, Scene } from './types.js';
// token 缓存在全局命名空间：实际 key = `bot:global:app_access_token`
const TOKEN_KEY = 'app_access_token';
interface TokenCache { access_token?: string; expire_at?: number; }
export async function getAccessToken(cfg: Config): Promise<string> {
  const cache = cfg.storage.infra.global; // key: bot:global:app_access_token
  if (cache.available) {
    try {
      const cached = await cache.getJSON<TokenCache>(TOKEN_KEY);
      if (cached && cached.access_token && cached.expire_at && cached.expire_at > Date.now() + 60_000) {
        return cached.access_token;
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
  if (cache.available) {
    try {
      await cache.setJSON(TOKEN_KEY, { access_token: token, expire_at: Date.now() + expiresIn * 1000 });
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

// ---------- 消息/文件端点（单聊与群聊相互隔离） ----------
function messagesPath(scene: Scene, openid: string): string {
  return scene === 'group'
    ? '/v2/groups/' + encodeURIComponent(openid) + '/messages'
    : '/v2/users/' + encodeURIComponent(openid) + '/messages';
}
function filesPath(scene: Scene, openid: string): string {
  return scene === 'group'
    ? '/v2/groups/' + encodeURIComponent(openid) + '/files'
    : '/v2/users/' + encodeURIComponent(openid) + '/files';
}
// 统一发送：msg_id 存在时挂到 body（被动回复）
async function postMessage(cfg: Config, scene: Scene, openid: string, body: Record<string, unknown>, msgId?: string): Promise<any> {
  if (msgId) body.msg_id = msgId;
  return apiCall(cfg, 'POST', messagesPath(scene, openid), body);
}
/** 原样发送消息体（msg_id/msg_seq 由调用方组装，供 reply.ts 递增 msg_seq 实现多次被动回复） */
export async function sendBody(cfg: Config, scene: Scene, openid: string, body: Record<string, unknown>): Promise<any> {
  return apiCall(cfg, 'POST', messagesPath(scene, openid), body);
}

// ---------- 文本（msg_type=0） ----------
// 发送群消息（被动回复：传入消息 id 作为 msg_id）
export async function sendGroupMessage(cfg: Config, groupOpenid: string, content: string, msgId?: string): Promise<any> {
  return postMessage(cfg, 'group', groupOpenid, { content, msg_type: 0 }, msgId);
}
// 发送单聊消息（被动回复：传入消息 id 作为 msg_id）
export async function sendC2CMessage(cfg: Config, userOpenid: string, content: string, msgId?: string): Promise<any> {
  return postMessage(cfg, 'private', userOpenid, { content, msg_type: 0 }, msgId);
}

// ---------- Markdown（msg_type=2，body.markdown） ----------
// 自定义 markdown 已对所有机器人开放（无需申请模板）；单聊只发不收，群聊收发均支持。
export async function sendMarkdown(cfg: Config, scene: Scene, openid: string, markdown: string, msgId?: string): Promise<any> {
  return postMessage(cfg, scene, openid, { msg_type: 2, markdown: { content: markdown } }, msgId);
}

// ---------- 富媒体（先上传拿 file_info，再 msg_type=7 + media） ----------
// URL 上传：单聊与群聊上传接口相互隔离，file_info 有效期 ttl（秒，0=可长期使用），不可跨场景复用；
// 固定 srv_send_msg=false（不占每月 4 条主动消息额度）；url 必须以 http(s) 开头（平台会下载转存）。
export async function uploadFile(cfg: Config, scene: Scene, openid: string, fileType: MediaType, url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('上传富媒体失败：url 必须以 http(s):// 开头（平台不支持 data:/本地路径），当前为 ' + url);
  }
  const r = await apiCall(cfg, 'POST', filesPath(scene, openid), { file_type: fileType, url, srv_send_msg: false });
  // 文档明确 file_info 为 string；非字符串说明返回结构异常，直接抛错并带原始响应，
  // 避免把对象 JSON.stringify 成非法 media.file_info 把错误伪装到发送环节。
  const fi = r && typeof r === 'object' ? (r as any).file_info : undefined;
  if (typeof fi !== 'string' || !fi) {
    throw new Error('上传富媒体失败：file_info 结构异常 ' + JSON.stringify(r ?? r).slice(0, 300));
  }
  return fi;
}
// 发送富媒体（msg_type=7 + media.file_info）
export async function sendMedia(cfg: Config, scene: Scene, openid: string, fileInfo: string, msgId?: string): Promise<any> {
  return postMessage(cfg, scene, openid, { msg_type: 7, media: { file_info: fileInfo } }, msgId);
}

// ---------- 群成员 ----------
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
