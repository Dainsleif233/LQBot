// Webhook 主逻辑：验签/地址校验/分发事件/执行命令。
import { createConfig } from './config.js';
import { signWebhookChallenge, verifyWebhookSignature } from './crypto.js';
import { resolveLevel, LEVELS } from './permissions.js';
import { parseCommand, findCommand } from './registry.js';
import { createReply } from './reply.js';
import { isDuplicate } from './dedupe.js';
import * as qq from './qq.js';
import type { CommandContext, Config, EdgeContext, MemberInfo, Scene } from './types.js';
const jsonHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
export async function handleWebhook(context: EdgeContext): Promise<Response> {
  const { request, env, waitUntil } = context;
  const cfg = createConfig(env);
  const method = request.method || 'GET';
  if (method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: jsonHeaders });
  }
  const rawBody = await request.text();
  let payload: any;
  try { payload = JSON.parse(rawBody); } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: jsonHeaders });
  }
  // op=13：回调地址验证（必须返回签名，否则无法配置 webhook）
  if (payload && payload.op === 13) {
    return await handleVerification(cfg, payload);
  }
  // op=0：事件分发
  if (payload && payload.op === 0) {
    // 可选：校验每次回调签名
    if (cfg.verifyEventSignature) {
      const sig = request.headers.get('X-Signature-Ed25519');
      const ts = request.headers.get('X-Signature-Timestamp');
      if (!sig || !ts) return new Response(JSON.stringify({ error: 'missing signature' }), { status: 401, headers: jsonHeaders });
      const ok = await verifyWebhookSignature(cfg.appSecret, ts, rawBody, sig);
      if (!ok) return new Response(JSON.stringify({ error: 'invalid signature' }), { status: 401, headers: jsonHeaders });
    }
    // 同步处理事件后再返回 200：确保被动回复真正发出、日志落盘。
    // （边缘运行时可能在返回 200 后立即冻结 isolate，用 waitUntil 后台跑会丢失回复与日志；
    //   被动回复窗口群 5 分钟 / 单聊 60 分钟，同步处理完全来得及。）
    try {
      await processEvent(cfg, payload);
    } catch (e) {
      console.error('[LQBot] processEvent error:', e);
    }
    return new Response(JSON.stringify({ op: 12 }), { status: 200, headers: jsonHeaders });
  }
  // 其它 op（如 12 ACK 回显）忽略
  return new Response(JSON.stringify({ op: 12 }), { status: 200, headers: jsonHeaders });
}
async function handleVerification(cfg: Config, payload: any): Promise<Response> {
  const d = payload.d || {};
  const plainToken = d.plain_token;
  const eventTs = d.event_ts;
  if (!plainToken || eventTs === undefined || eventTs === null) {
    return new Response(JSON.stringify({ error: 'bad verification payload' }), { status: 400, headers: jsonHeaders });
  }
  if (!cfg.appSecret) {
    return new Response(JSON.stringify({ error: 'APP_SECRET/WEBHOOK_SECRET 未配置，无法完成地址校验' }), { status: 500, headers: jsonHeaders });
  }
  try {
    const signature = await signWebhookChallenge(cfg.appSecret, plainToken, eventTs);
    return new Response(JSON.stringify({ plain_token: plainToken, signature }), { status: 200, headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: '签名失败: ' + (e as Error).message }), { status: 500, headers: jsonHeaders });
  }
}
async function processEvent(cfg: Config, payload: any): Promise<void> {
  const t = payload.t;
  if (t !== 'GROUP_AT_MESSAGE_CREATE' && t !== 'C2C_MESSAGE_CREATE') {
    return;
  }
  const event = payload;
  const d = event.d || {};
  const scene: Scene = t === 'C2C_MESSAGE_CREATE' ? 'private' : 'group';
  // 被动回复用 msg_id（= 接收到的消息 id d.id，形如 ROBOT1.0_...），不是 event_id。
  // event.id 是事件 id（C2C_MESSAGE_CREATE:...），QQ 被动回复不认它。
  const messageId = d.id || (event && event.id) || '';
  // 去重：QQ 可能重复投递同一 msg_id，窗口期内视为重复并跳过（实现见 lib/dedupe.ts）。
  if (await isDuplicate(cfg, messageId)) {
    return;
  }
  // 解析发送者身份
  let userOpenid: string | null = null;
  let memberOpenid: string | null = null;
  let groupOpenid: string | null = null;
  let nick = '';
  let memberInfo: MemberInfo | null = null;
  const author = d.author || {};
  if (scene === 'private') {
    userOpenid = author.user_openid || author.id || '';
    // C2C 消息事件的 username 通常为空（QQ 出于隐私不在私聊事件提供昵称），尽力取常见字段。
    nick = author.username || author.nick || author.nickname || author.user_name || '';
  } else {
    groupOpenid = d.group_openid;
    memberOpenid = author.member_openid || '';
    // 群消息事件的 author 自带 username(昵称) 与 member_role(角色)，无需调群成员接口
    // （该接口需「群成员」权限，未开通会返回 11253 应用无接口访问权限）。
    nick = author.username || author.nick || '';
    memberInfo = {
      user_openid: author.user_openid || memberOpenid || undefined,
      member_openid: memberOpenid || undefined,
      nick,
      role: author.member_role,
    };
    userOpenid = author.user_openid || memberOpenid || userOpenid;
  }
  // 解析命令
  const parsed = parseCommand(d.content);
  if (!parsed) { return; }
  const cmd = findCommand(parsed.name);
  if (!cmd) { return; } // 未知命令静默忽略
  if (cmd.scenes && cmd.scenes.indexOf(scene) === -1) {
    return; // 该命令不适用于当前场景
  }
  // 解析权限
  const level = await resolveLevel(cfg, { scene, userOpenid, groupOpenid, memberOpenid, memberInfo });
  const reply = createReply(cfg, event, scene);
  const ctx: CommandContext = {
    name: parsed.name,
    args: parsed.args,
    raw: parsed.raw,
    original: (typeof d.content === 'string' ? d.content : '').trim(),
    scene,
    userOpenid,
    memberOpenid,
    groupOpenid,
    nick,
    level,
    memberInfo,
    event,
    messageId,
    cfg,
    qq,
    reply,
    // 便捷：需要更高等级时的拒绝回复
    async deny() {
      return reply('权限不足：需要等级 ' + cmd.minLevel + '（' + levelNameSafe(cmd.minLevel) + '），当前等级 ' + level);
    },
  };
  // 权限检查（挡位进阶：level >= minLevel 即通过）
  if (level < cmd.minLevel) {
    try { await ctx.deny(); } catch (e) { console.error('[LQBot] deny reply failed:', (e as Error).message); }
    return;
  }
  try {
    await cmd.handler(ctx);
  } catch (e) {
    console.error('[LQBot] command handler error:', e);
    try { await reply('命令执行出错：' + (e as Error).message); } catch (e2) { console.error('[LQBot] reply failed:', e2); }
  }
}
function levelNameSafe(n: number): string {
  const map: Record<number, string> = { 3: '超级管理员', 2: '全局管理员', 1: '群聊管理员', 0: '普通用户' };
  return map[n] || String(n);
}