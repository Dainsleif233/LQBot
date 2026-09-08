// QQ OpenAPI 客户端：换取 access_token、发送群/单聊消息、查询群成员。
// access_token 缓存在 KV（避免频繁换取，token 有效期通常 7200s）。

const TOKEN_KEY = 'bot:app_access_token';

export async function getAccessToken(cfg) {
  // 1. 先尝试 KV 缓存
  if (cfg.kv) {
    try {
      const cached = await cfg.kv.get(TOKEN_KEY, 'json');
      if (cached && cached.access_token && cached.expire_at && cached.expire_at > Date.now() + 60_000) {
        return cached.access_token;
      }
    } catch (_) { /* 缓存不存在或损坏，忽略 */ }
  }

  // 2. 调用 https://bots.qq.com/app/getAppAccessToken
  const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: cfg.appId, clientSecret: cfg.appSecret }),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = {}; }
  if (!data.access_token) {
    throw new Error('getAppAccessToken 失败: ' + text);
  }
  const token = data.access_token;
  const expiresIn = Number(data.expires_in) || 7200;

  // 3. 写回 KV 缓存（留 60s 安全余量）
  if (cfg.kv) {
    try {
      await cfg.kv.put(TOKEN_KEY, JSON.stringify({ access_token: token, expire_at: Date.now() + expiresIn * 1000 }));
    } catch (_) { /* 缓存写入失败不影响主流程 */ }
  }
  return token;
}

async function apiCall(cfg, method, path, body) {
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
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  if (!resp.ok) {
    throw new Error('QQ API ' + method + ' ' + path + ' -> ' + resp.status + ': ' + text);
  }
  return data;
}

// 发送群消息（被动回复：传入事件消息 id 作为 event_id）
export async function sendGroupMessage(cfg, groupOpenid, content, eventId) {
  const body = { content, msg_type: 0 };
  if (eventId) body.event_id = eventId;
  return apiCall(cfg, 'POST', '/v2/groups/' + encodeURIComponent(groupOpenid) + '/messages', body);
}

// 发送单聊消息（被动回复：传入事件消息 id 作为 event_id）
export async function sendC2CMessage(cfg, userOpenid, content, eventId) {
  const body = { content, msg_type: 0 };
  if (eventId) body.event_id = eventId;
  return apiCall(cfg, 'POST', '/v2/users/' + encodeURIComponent(userOpenid) + '/messages', body);
}

// 获取群内单个成员详情：{ member_openid, user_openid, nick, role, ... }
export async function getGroupMember(cfg, groupOpenid, memberOpenid) {
  return apiCall(cfg, 'GET',
    '/v2/groups/' + encodeURIComponent(groupOpenid) + '/members/' + encodeURIComponent(memberOpenid));
}

// 获取群成员列表（分页）。返回原始响应，由调用方兼容处理字段。
export async function listGroupMembers(cfg, groupOpenid, limit, after) {
  const q = new URLSearchParams();
  if (limit) q.set('limit', String(limit));
  if (after) q.set('after', String(after));
  return apiCall(cfg, 'GET',
    '/v2/groups/' + encodeURIComponent(groupOpenid) + '/members' + (q.toString() ? '?' + q : ''));
}
