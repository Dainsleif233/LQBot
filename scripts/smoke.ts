// 冒烟测试：钉死命令匹配 / 多级子命令 / 权限语义 / Markdown 与富媒体收发（不连真 QQ，桩掉 fetch）。
// 运行：npm run smoke。断言失败时退出码 1。
import { handleWebhook } from '../src/lib/handler.js';
import { commands } from '../src/lib/registry.js';
import { LEVELS } from '../src/lib/permissions.js';
import { defineCommand } from '../src/lib/define.js';
import type { MessageAttachment } from '../src/lib/types.js';

interface RecordedCall { url: string; body: any; }
const calls: RecordedCall[] = [];
/** 为 true 时 /messages 返回 40054005（msg_seq 去重） */
let failMsgSeqDedupe = false;
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
  if (url.includes('/messages')) {
    if (failMsgSeqDedupe) {
      return new Response(JSON.stringify({
        message: '消息被去重，请检查请求msgseq',
        code: 40054005,
        err_code: 40054005,
      }), { status: 400 });
    }
    // 模拟官方发送响应：id + ext_info.ref_idx（入站引用用 REFIDX 对回）
    return new Response(JSON.stringify({
      id: 'ROBOT1.0_OUT',
      timestamp: '2026-01-01T00:00:00+08:00',
      ext_info: { ref_idx: 'REFIDX_OUT' },
    }), { status: 200 });
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

// 测试命令 3：引用回复基础设施（handler 拿 refIdx；onQuote 消费非 slash 引用消息）
interface QuoteHit { kind: 'ask' | 'quote' | 'slash'; id?: string; refIdx?: string | null; ref?: string | null; text?: string; quoted?: string; }
const quoteHits: QuoteHit[] = [];
commands.push(defineCommand({
  name: 'qtest',
  description: '引用测试',
  minLevel: LEVELS.USER,
  async handler(ctx) {
    const sent = await ctx.reply('QTEST_QUESTION');
    quoteHits.push({ kind: 'slash', id: sent.id, refIdx: sent.refIdx });
  },
  async onQuote(ctx) {
    quoteHits.push({
      kind: 'quote',
      ref: ctx.quote?.refMsgIdx ?? null,
      text: ctx.quote?.text ?? '',
      quoted: ctx.quote?.quotedText ?? '',
    });
    await ctx.reply('QTEST_ANSWER text=' + (ctx.quote?.text || '') + ' ref=' + (ctx.quote?.refMsgIdx || ''));
    return true;
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

interface QuoteReqOpts {
  content?: string;
  messageId?: string;
  refMsgIdx?: string | null;
  messageType?: number | null;
  elements?: unknown[];
  scene?: 'private' | 'group';
}
function makeQuoteRequest(opts: QuoteReqOpts): Request {
  const isGroup = opts.scene === 'group';
  const d: any = {
    id: opts.messageId || ('ROBOT1.0_Q' + Math.random().toString(36).slice(2, 8)),
    content: opts.content ?? '',
    author: isGroup
      ? { member_openid: 'u_test', username: 'tester', member_role: 'member' }
      : { user_openid: 'u_test' },
  };
  if (isGroup) d.group_openid = 'g_test';
  if (opts.messageType != null) d.message_type = opts.messageType;
  const ext: string[] = [];
  if (opts.refMsgIdx) ext.push('ref_msg_idx=' + opts.refMsgIdx);
  ext.push('msg_idx=REFIDX_SELF');
  d.message_scene = { source: 'default', ext };
  if (opts.elements) d.msg_elements = opts.elements;
  const payload = { op: 0, t: isGroup ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', d };
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

  // ---------- 引用回复基础设施 ----------
  function expect(label: string, cond: boolean, detail?: unknown): void {
    if (!cond) fail++;
    console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '  实际: ' + JSON.stringify(detail)));
  }
  async function runQuote(opts: QuoteReqOpts, env: Record<string, string>): Promise<string> {
    calls.length = 0;
    await handleWebhook({ request: makeQuoteRequest(opts), env });
    return sentText();
  }

  // 发送响应 ext_info.ref_idx 进入 SentMessage.refIdx
  {
    quoteHits.length = 0;
    await run('/qtest', adminEnv);
    const ask = quoteHits.find((h) => h.kind === 'slash');
    expect('/qtest 回复返回 id+refIdx', !!ask && ask.id === 'ROBOT1.0_OUT' && ask.refIdx === 'REFIDX_OUT', ask);
  }

  // 非 slash + ref_msg_idx -> onQuote；正文与被引用正文解析正确
  {
    quoteHits.length = 0;
    const out = await runQuote({
      content: '  B  ',
      messageType: 103,
      refMsgIdx: 'REFIDX_OUT',
      elements: [{ msg_idx: 'REFIDX_OUT', content: 'QTEST_QUESTION' }],
    }, adminEnv);
    const hit = quoteHits.find((h) => h.kind === 'quote');
    expect('引用回复触发 onQuote', !!hit && hit.ref === 'REFIDX_OUT' && hit.text === 'B' && hit.quoted === 'QTEST_QUESTION', { hit, out });
    expect('onQuote 被动回复发出', out.includes('QTEST_ANSWER text=B ref=REFIDX_OUT'), out);
  }

  // slash 命令优先：引用 + /qtest 进 handler，不进 onQuote
  {
    quoteHits.length = 0;
    await runQuote({
      content: '/qtest',
      messageType: 103,
      refMsgIdx: 'REFIDX_OUT',
      elements: [{ content: 'old' }],
    }, adminEnv);
    expect('slash 优先不进 onQuote', quoteHits.every((h) => h.kind !== 'quote') && quoteHits.some((h) => h.kind === 'slash'), quoteHits);
  }

  // 非引用、非命令：静默忽略，不进 onQuote
  {
    quoteHits.length = 0;
    const out = await runQuote({ content: 'B', messageType: 0, refMsgIdx: null }, adminEnv);
    expect('非引用普通消息忽略', quoteHits.length === 0 && !out.includes('QTEST_ANSWER'), { quoteHits, out });
  }

  // 群聊引用同样分发 onQuote
  {
    quoteHits.length = 0;
    const out = await runQuote({
      scene: 'group',
      content: 'C',
      messageType: 103,
      refMsgIdx: 'REFIDX_OUT',
    }, adminEnv);
    const hit = quoteHits.find((h) => h.kind === 'quote');
    expect('群聊引用触发 onQuote', !!hit && hit.ref === 'REFIDX_OUT' && hit.text === 'C', { hit, out });
  }

  // 有 message_type=103 但无 ref_msg_idx：不进 onQuote（无法对题）
  {
    quoteHits.length = 0;
    await runQuote({ content: 'D', messageType: 103, refMsgIdx: null }, adminEnv);
    expect('无 ref_msg_idx 不分发', quoteHits.length === 0, quoteHits);
  }

  // QQ 40054005（msg_seq 去重）：吞掉，不向用户打「引用回复处理出错」
  {
    quoteHits.length = 0;
    failMsgSeqDedupe = true;
    const out = await runQuote({
      content: 'B',
      messageType: 103,
      refMsgIdx: 'REFIDX_OUT',
    }, adminEnv);
    failMsgSeqDedupe = false;
    expect('40054005 不向用户暴露错误',
      quoteHits.some((h) => h.kind === 'quote') && !out.includes('引用回复处理出错') && !out.includes('40054005'),
      { quoteHits, out });
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
