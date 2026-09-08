// Webhook 主逻辑：验签/地址校验/分发事件/执行命令。
import { createConfig } from './config.js';
import { signWebhookChallenge, verifyWebhookSignature } from './crypto.js';
import { resolveLevel, LEVELS } from './permissions.js';
import { parseCommand, findCommand } from './registry.js';
import { createReply } from './reply.js';
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
    console.error('[LQBot][debug] JSON 解析失败: ' + (e as Error).message);
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: jsonHeaders });
  }
  console.error('[LQBot][debug] 收到请求 method=' + method + ' op=' + (payload && payload.op));

  // op=13：回调地址验证（必须返回签名，否则无法配置 webhook）
  if (payload && payload.op === 13) {
    console.error('[LQBot][debug] 处理 op=13 地址校验');
    return await handleVerification(cfg, payload);
  }

  // op=0：事件分发
  if (payload && payload.op === 0) {
    console.error('[LQBot][debug] op=0 事件分发, t=' + (payload.t || '') + ' d.id=' + (payload.d && payload.d.id));
    // 可选：校验每次回调签名
    if (cfg.verifyEventSignature) {
      const sig = request.headers.get('X-Signature-Ed25519');
      const ts = request.headers.get('X-Signature-Timestamp');
      console.error('[LQBot][debug] 校验事件签名, 有sig=' + (!!sig) + ' 有ts=' + (!!ts));
      if (!sig || !ts) return new Response(JSON.stringify({ error: 'missing signature' }), { status: 401, headers: jsonHeaders });
      const ok = await verifyWebhookSignature(cfg.appSecret, ts, rawBody, sig);
      console.error('[LQBot][debug] 事件签名校验结果=' + ok);
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
  console.error('[LQBot][debug] processEvent 开始, t=' + (t || '') + ' d.id=' + (payload.d && payload.d.id));
  if (t !== 'GROUP_AT_MESSAGE_CREATE' && t !== 'C2C_MESSAGE_CREATE') {
    console.error('[LQBot][debug] 忽略事件类型: ' + (t || 'undefined'));
    return;
  }

  const event = payload;
  const d = event.d || {};
  console.error('[LQBot][debug] d字段keys=' + JSON.stringify(Object.keys(d)) + ' d.id=' + (d && d.id) + ' event.id=' + (event && event.id));
  const scene: Scene = t === 'C2C_MESSAGE_CREATE' ? 'private' : 'group';
  // 被动回复用 msg_id（= 接收到的消息 id d.id，形如 ROBOT1.0_...），不是 event_id。
  // event.id 是事件 id（C2C_MESSAGE_CREATE:...），QQ 被动回复不认它。
  const messageId = d.id || (event && event.id) || '';
  console.error('[LQBot][debug] scene=' + scene + ' messageId=' + messageId);

  // 去重：QQ 可能重复投递同一 msg_id，用 KV 记录已处理（10 分钟窗口手动过期）。
  if (cfg.kv && messageId) {
    try {
      const seen = await cfg.kv.get('seen:' + messageId);
      if (seen) {
        const ts = Number(seen);
        if (!Number.isNaN(ts) && Date.now() - ts < 600_000) {
          console.error('[LQBot][debug] 去重命中，跳过 messageId=' + messageId);
          return; // 10 分钟内视为重复
        }
      }
      await cfg.kv.put('seen:' + messageId, String(Date.now()));
    } catch (_) { /* KV 不可用则跳过去重 */ }
  }

  // 解析发送者身份
  let userOpenid: string | null = null;
  let memberOpenid: string | null = null;
  let groupOpenid: string | null = null;
  let nick = '';
  let memberInfo: MemberInfo | null = null;

  if (scene === 'private') {
    userOpenid = d.author && d.author.user_openid;
  } else {
    groupOpenid = d.group_openid;
    memberOpenid = d.author && d.author.member_openid;
    // 群成员事件只给 member_openid，需要查成员接口拿到稳定的 user_openid 与昵称
    if (groupOpenid && memberOpenid) {
      try {
        memberInfo = await qq.getGroupMember(cfg, groupOpenid, memberOpenid);
        userOpenid = memberInfo.user_openid || userOpenid;
        nick = memberInfo.nick || '';
      } catch (e) {
        console.error('[LQBot] getGroupMember failed:', (e as Error).message);
        userOpenid = userOpenid || memberOpenid; // 回落到群内 id
      }
    }
  }
  console.error('[LQBot][debug] 发送者: userOpenid=' + userOpenid + ' groupOpenid=' + groupOpenid + ' memberOpenid=' + memberOpenid + ' nick=' + nick + ' memberInfo=' + (memberInfo ? 'yes' : 'no'));

  // 解析命令
  const parsed = parseCommand(d.content);
  console.error('[LQBot][debug] 原内容=' + JSON.stringify(d.content) + ' 解析=' + JSON.stringify(parsed));
  if (!parsed) { console.error('[LQBot][debug] 不是命令（不以 / 开头），忽略'); return; }
  const cmd = findCommand(parsed.name);
  console.error('[LQBot][debug] 命令=' + (cmd ? cmd.name : '未找到'));
  if (!cmd) { console.error('[LQBot][debug] 未知命令，忽略'); return; } // 未知命令静默忽略
  if (cmd.scenes && cmd.scenes.indexOf(scene) === -1) {
    console.error('[LQBot][debug] 命令不适用于当前场景 scene=' + scene);
    return; // 该命令不适用于当前场景
  }

  // 解析权限
  const level = await resolveLevel(cfg, { scene, userOpenid, groupOpenid, memberOpenid, memberInfo });
  console.error('[LQBot][debug] 权限等级=' + level + ' 命令最低等级=' + cmd.minLevel);

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
    console.error('[LQBot][debug] 权限不足，发送拒绝回复');
    try { await ctx.deny(); } catch (e) { console.error('[LQBot] deny reply failed:', (e as Error).message); }
    return;
  }

  try {
    await cmd.handler(ctx);
    console.error('[LQBot][debug] 命令执行完成');
  } catch (e) {
    console.error('[LQBot] command handler error:', e);
    try { await reply('命令执行出错：' + (e as Error).message); console.error('[LQBot][debug] 已发送错误回复'); } catch (e2) { console.error('[LQBot] reply failed:', e2); }
  }
}

function levelNameSafe(n: number): string {
  const map: Record<number, string> = { 3: '超级管理员', 2: '全局管理员', 1: '群聊管理员', 0: '普通用户' };
  return map[n] || String(n);
}
