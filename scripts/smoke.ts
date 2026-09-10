// 冒烟测试：钉死命令匹配 / 多级子命令 / 权限语义 / Markdown 与富媒体收发（不连真 QQ，桩掉 fetch）。
// 运行：npm run smoke。断言失败时退出码 1。
import { handleWebhook } from '../src/lib/handler.js';
import { commands } from '../src/lib/registry.js';
import { LEVELS } from '../src/lib/permissions.js';
import { defineCommand } from '../src/lib/define.js';
import type { MessageAttachment } from '../src/lib/types.js';

interface RecordedCall { url: string; body: any; }
const calls: RecordedCall[] = [];
const realFetch = globalThis.fetch;
// 桩掉 fetch：token 返回假 token；/files 返回固定 file_info；其余记录 url+body（消息发送）
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String((input as Request)?.url ?? input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.includes('getAppAccessToken')) {
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 });
  }
  calls.push({ url, body });
  if (url.includes('/files')) {
    return new Response(JSON.stringify({ file_info: 'FI_SMOKE' }), { status: 200 });
  }
  return new Response(JSON.stringify({ ret: 0, msg: 'ok' }), { status: 200 });
}) as typeof fetch;

// 测试命令 1：按文档示例的多级子命令
commands.push(defineCommand({
  name: 'game',
  description: '游戏',
  minLevel: LEVELS.USER,
  async handler(ctx) { await ctx.reply('GAME_ROOT sub=' + ctx.sub + ' args=' + ctx.args.join(',')); },
  subcommands: [
    {
      name: 'add',
      aliases: ['new'],
      description: '添加一局游戏',
      minLevel: LEVELS.GLOBAL_ADMIN,
      async handler(ctx) { await ctx.reply('GAME_ADD sub=' + ctx.sub + ' args=' + ctx.args.join(',')); },
    },
    {
      name: 'room',
      description: '房间管理',
      subcommands: [
        {
          name: 'create',
          description: '创建房间',
          minLevel: LEVELS.GLOBAL_ADMIN,
          async handler(ctx) { await ctx.reply('GAME_ROOM_CREATE sub=' + ctx.sub + ' args=' + ctx.args.join(',')); },
        },
      ],
    },
  ],
}));

// 测试命令 2：Markdown / 富媒体 / 附件回显
commands.push(defineCommand({
  name: 'media',
  description: '媒体',
  minLevel: LEVELS.USER,
  async handler(ctx) {
    if (ctx.args[0] === 'md') {
      await ctx.replyMarkdown('# hi **bold**');
      return;
    }
    if (ctx.args[0] === 'img') {
      await ctx.replyMedia(1, 'https://example.com/a.png');
      return;
    }
    if (ctx.args[0] === 'two') {
      await ctx.reply('第一条');
      await ctx.reply('第二条');
      return;
    }
    await ctx.reply('ATT ' + ctx.attachments.map((a) => a.contentType + ':' + (a.url || '') + ':' + (a.filename || '')).join('|'));
  },
}));

function makeRequest(content: string, attachments?: MessageAttachment[]): Request {
  const d: any = { id: 'ROBOT1.0_SMOKE', content, author: { user_openid: 'u_test' } };
  if (attachments) d.attachments = attachments;
  const payload = { op: 0, t: 'C2C_MESSAGE_CREATE', d };
  return new Request('http://localhost/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const adminEnv = { VERIFY_EVENT_SIGNATURE: 'false', APP_ID: 'app', APP_SECRET: 'sec', SUPER_ADMIN_OPENID: 'u_test' };
const userEnv = { VERIFY_EVENT_SIGNATURE: 'false', APP_ID: 'app', APP_SECRET: 'sec' };

async function run(content: string, env: Record<string, string>, attachments?: MessageAttachment[]): Promise<string> {
  calls.length = 0;
  await handleWebhook({ request: makeRequest(content, attachments), env });
  return sentText();
}
// 最后一条发往 /messages 的请求
function lastMessageCall(): RecordedCall {
  const msgs = calls.filter((c) => c.url.includes('/messages'));
  return msgs[msgs.length - 1] ?? { url: '', body: {} };
}
function sentText(): string {
  return String(lastMessageCall().body?.content ?? '');
}

let fail = 0;
async function expectText(label: string, content: string, env: Record<string, string>, needle: string): Promise<void> {
  const out = await run(content, env);
  const ok = out.includes(needle);
  if (!ok) fail++;
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : '  实际: ' + JSON.stringify(out)));
}
async function expectReq(label: string, content: string, env: Record<string, string>, check: (c: RecordedCall) => boolean): Promise<void> {
  await run(content, env);
  const last = lastMessageCall();
  const ok = check(last);
  if (!ok) fail++;
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : '  实际: ' + JSON.stringify(last)));
}

async function main(): Promise<void> {
  await expectText('/game 本体', '/game', adminEnv, 'GAME_ROOT sub=null');
  await expectText('/game add 命中子命令', '/game add sword', adminEnv, 'GAME_ADD sub=add args=sword');
  await expectText('/game new 走别名', '/game new sword', adminEnv, 'GAME_ADD sub=add args=sword');
  await expectText('/game room 分组节点回用法', '/game room', adminEnv, '用法：/game room');
  await expectText('/game room 列出子命令', '/game room', adminEnv, '• /game room create — 创建房间');
  await expectText('/game room create 多级命中', '/game room create r1', adminEnv, 'GAME_ROOM_CREATE sub=room create args=r1');
  await expectText('/game foo bar 未命中回落主命令', '/game foo bar', adminEnv, 'GAME_ROOT sub=null args=foo,bar');
  await expectText('/game add 等级1被拒', '/game add sword', userEnv, '权限不足：game add 需要等级 2');
  await expectText('/game room create 等级1被拒', '/game room create r1', userEnv, '权限不足：game room create 需要等级 2');

  // Markdown 发送：msg_type=2 + markdown.content，并携带 msg_id（被动回复）
  await expectReq('/media md 发送 Markdown', '/media md', adminEnv, (c) =>
    c.body?.msg_type === 2 && c.body?.markdown?.content === '# hi **bold**' && typeof c.body?.msg_id === 'string');
  // 富媒体发送：先 /files 上传（file_type/url/srv_send_msg=false），再 msg_type=7 携带 file_info 与 msg_id
  await expectReq('/media img 富媒体上传+发送', '/media img', adminEnv, (c) => {
    const files = calls.filter((x) => x.url.includes('/files'));
    const upload = files[0];
    const uploadOk = !!upload
      && upload.body?.file_type === 1
      && upload.body?.url === 'https://example.com/a.png'
      && upload.body?.srv_send_msg === false;
    const msgOk = c.body?.msg_type === 7 && c.body?.media?.file_info === 'FI_SMOKE' && typeof c.body?.msg_id === 'string';
    return uploadOk && msgOk;
  });
  // 多次被动回复：同一 msg_id，msg_seq 递增（1、2）
  {
    await run('/media two', adminEnv);
    const msgs = calls.filter((x) => x.url.includes('/messages'));
    const ok = msgs.length === 2
      && msgs[0].body?.msg_seq === 1 && msgs[0].body?.content === '第一条'
      && msgs[1].body?.msg_seq === 2 && msgs[1].body?.content === '第二条'
      && msgs[0].body?.msg_id === msgs[1].body?.msg_id;
    if (!ok) fail++;
    console.log((ok ? '✓' : '✗') + ' /media two 多次回复 msg_seq 递增' + (ok ? '' : '  实际: ' + JSON.stringify(msgs.map((m) => m.body))));
  }

  // 富媒体接收：事件带 attachments -> 插件读到归一化的 contentType/url/filename
  {
    const atts: MessageAttachment[] = [{ contentType: 'image', url: 'https://e/i.png', filename: 'i.png', raw: {} }];
    const out = await run('/media', userEnv, atts);
    const ok = out.includes('ATT image:https://e/i.png:i.png');
    if (!ok) fail++;
    console.log((ok ? '✓' : '✗') + ' /media 读取附件' + (ok ? '' : '  实际: ' + JSON.stringify(out)));
  }

  if (fail > 0) {
    console.error('冒烟测试失败：' + fail + ' 项');
    process.exit(1);
  }
  console.log('冒烟测试全部通过。');
}

main().catch((e) => {
  console.error('冒烟测试异常：' + (e instanceof Error ? e.message : e));
  process.exit(1);
});
