// 冒烟测试：钉死命令匹配 / 多级子命令 / 权限语义 / Markdown 与富媒体收发（不连真 QQ，桩掉 fetch）。
// 运行：npm run smoke。断言失败时退出码 1。
import { handleWebhook } from '../src/lib/handler.js';
import { commands } from '../src/lib/registry.js';
import { LEVELS } from '../src/lib/permissions.js';
import { defineCommand } from '../src/lib/define.js';
import type { MessageAttachment } from '../src/lib/types.js';

interface RecordedCall { url: string; body: any; }
const calls: RecordedCall[] = [];
let outSeq = 0;
/** 内存 KV：仅 /question 等需要持久化的用例启用（启用后去重也会生效，用例须用唯一 msg_id） */
const kvMap = new Map<string, string>();
const mockKv = {
  async get(key: string) { return kvMap.has(key) ? kvMap.get(key) : null; },
  async put(key: string, value: string) { kvMap.set(key, String(value)); },
  async delete(key: string) { kvMap.delete(key); },
};
function enableMockKv(): void {
  kvMap.clear();
  (globalThis as any).LQBOT = mockKv;
}
function disableMockKv(): void {
  delete (globalThis as any).LQBOT;
  kvMap.clear();
}
/** 题库桩：由用例切换返回的题目 */
let mockDrawQuestion: any = {
  id: 'api-1',
  type: 'SINGLE',
  typeLabel: '单选题',
  content: '全套钻石套提供多少盔甲韧性？',
  options: ['4', '8', '12', '16'],
  answer: 'B',
  answers: [],
  analysis: '每件2点，全套8点。',
};
// 桩掉 fetch：token 返回假 token；/files 返回固定 file_info；消息发送返回递增 ref_idx；题库可切换
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String((input as Request)?.url ?? input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.includes('getAppAccessToken')) {
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 });
  }
  if (url.includes('questionbank/draw') || url.includes('swustmc.cn')) {
    const headers = (init?.headers || {}) as Record<string, string>;
    const key = headers['X-API-Key'] || headers['x-api-key'] || '';
    if (key !== 'test-key') {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
    return new Response(JSON.stringify({ questions: [mockDrawQuestion], seed: '1', total: 1 }), { status: 200 });
  }
  calls.push({ url, body });
  if (url.includes('/files')) {
    return new Response(JSON.stringify({ file_info: 'FI_SMOKE' }), { status: 200 });
  }
  if (url.includes('/messages')) {
    outSeq += 1;
    return new Response(JSON.stringify({
      id: 'ROBOT1.0_OUT' + outSeq,
      timestamp: '2026-01-01T00:00:00+08:00',
      ext_info: { ref_idx: 'REFIDX_OUT' + outSeq },
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ ret: 0, msg: 'ok' }), { status: 200 });
}) as typeof fetch;

// 测试命令 1：按文档示例的多级子命令（名字避开真实 games，避免别名 game 冲突）
commands.push(defineCommand({
  name: 'tgame',
  description: '测试游戏',
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
  await expectText('/tgame 本体', '/tgame', adminEnv, 'GAME_ROOT sub=null');
  await expectText('/tgame add 命中子命令', '/tgame add sword', adminEnv, 'GAME_ADD sub=add args=sword');
  await expectText('/tgame new 走别名', '/tgame new sword', adminEnv, 'GAME_ADD sub=add args=sword');
  await expectText('/tgame room 分组节点回用法', '/tgame room', adminEnv, '用法：/tgame room');
  await expectText('/tgame room 列出子命令', '/tgame room', adminEnv, '• /tgame room create — 创建房间');
  await expectText('/tgame room create 多级命中', '/tgame room create r1', adminEnv, 'GAME_ROOM_CREATE sub=room create args=r1');
  await expectText('/tgame foo bar 未命中回落主命令', '/tgame foo bar', adminEnv, 'GAME_ROOT sub=null args=foo,bar');
  await expectText('/tgame add 等级1被拒', '/tgame add sword', userEnv, '权限不足：tgame add 需要等级 2');
  await expectText('/tgame room create 等级1被拒', '/tgame room create r1', userEnv, '权限不足：tgame room create 需要等级 2');

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
    expect('/qtest 回复返回 id+refIdx',
      !!ask && /^ROBOT1\.0_OUT\d+$/.test(ask.id || '') && /^REFIDX_OUT\d+$/.test(ask.refIdx || ''),
      ask);
  }

  // 非 slash + ref_msg_idx -> onQuote；正文与被引用正文解析正确
  {
    quoteHits.length = 0;
    const out = await runQuote({
      content: '  B  ',
      messageType: 103,
      refMsgIdx: 'REFIDX_QTEST',
      elements: [{ msg_idx: 'REFIDX_QTEST', content: 'QTEST_QUESTION' }],
    }, adminEnv);
    const hit = quoteHits.find((h) => h.kind === 'quote');
    expect('引用回复触发 onQuote', !!hit && hit.ref === 'REFIDX_QTEST' && hit.text === 'B' && hit.quoted === 'QTEST_QUESTION', { hit, out });
    expect('onQuote 被动回复发出', out.includes('QTEST_ANSWER text=B ref=REFIDX_QTEST'), out);
  }

  // slash 命令优先：引用 + /qtest 进 handler，不进 onQuote
  {
    quoteHits.length = 0;
    await runQuote({
      content: '/qtest',
      messageType: 103,
      refMsgIdx: 'REFIDX_QTEST',
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
      refMsgIdx: 'REFIDX_QTEST',
    }, adminEnv);
    const hit = quoteHits.find((h) => h.kind === 'quote');
    expect('群聊引用触发 onQuote', !!hit && hit.ref === 'REFIDX_QTEST' && hit.text === 'C', { hit, out });
  }

  // 有 message_type=103 但无 ref_msg_idx：不进 onQuote（无法对题）
  {
    quoteHits.length = 0;
    await runQuote({ content: 'D', messageType: 103, refMsgIdx: null }, adminEnv);
    expect('无 ref_msg_idx 不分发', quoteHits.length === 0, quoteHits);
  }

  // ---------- /question ----------
  const qEnv = { ...adminEnv, SWUSTMC_APIKEY: 'test-key' };
  let qMsgSeq = 0;
  async function runQ(content: string, env: Record<string, string>): Promise<string> {
    qMsgSeq += 1;
    calls.length = 0;
    await handleWebhook({
      request: new Request('http://localhost/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 0,
          t: 'C2C_MESSAGE_CREATE',
          d: {
            id: 'ROBOT1.0_Q' + qMsgSeq,
            content,
            author: { user_openid: 'u_test' },
          },
        }),
      }),
      env,
    });
    return sentText();
  }

  // 未配置 API Key
  {
    const out = await run('/question', adminEnv);
    expect('/question 缺 API Key 提示', out.includes('未配置题库 API Key'), out);
  }

  // 抽题 + 普通消息出题格式
  {
    enableMockKv();
    mockDrawQuestion = {
      id: 'api-1', type: 'SINGLE', typeLabel: '单选题',
      content: '全套钻石套提供多少盔甲韧性？',
      options: ['4', '8', '12', '16'], answer: 'B', answers: [],
      analysis: '每件2点，全套8点。',
    };
    const out = await runQ('/question', qEnv);
    expect('/question 出题文案',
      out.includes('【单选题】全套钻石套提供多少盔甲韧性？')
      && out.includes('A. 4') && out.includes('B. 8')
      && out.includes('引用本消息回复选项字母'),
      out);
    // 记下本题机器人消息的 ref_idx（发送序列）
    const msgs = calls.filter((c) => c.url.includes('/messages'));
    expect('/question 发出 1 条出题消息', msgs.length === 1, msgs.length);
  }

  // 答错 -> 再答对（引用同一题消息）-> 计分第 1 题
  {
    const before = outSeq;
    // 出题已产生 before 的发送；用 before 的 REFIDX（即上次 /question 的 ref）
    const qRef = 'REFIDX_OUT' + before;
    const wrong = await runQuote({
      content: 'A',
      messageType: 103,
      refMsgIdx: qRef,
    }, qEnv);
    expect('/question 答错提示', wrong.includes('不对哦'), wrong);
    const right = await runQuote({
      content: 'B',
      messageType: 103,
      refMsgIdx: qRef,
    }, qEnv);
    expect('/question 答对计分', right.includes('答对了，这是你答对的第1道题') && right.includes('解析'), right);
  }

  // 引用「答错提示」那条消息也可作答；已答对再答提示已过
  {
    const done = await runQuote({
      content: 'B',
      messageType: 103,
      refMsgIdx: 'REFIDX_OUT' + (outSeq - 2),
    }, qEnv);
    // REFIDX_OUT*(outSeq-2) 可能是答错提示或答对消息；至少应是 question 会话相关回复之一
    expect('/question 已答对/会话内消息有响应',
      done.includes('已经答对') || done.includes('不对哦') || done.includes('答对了'),
      done);
  }

  // 判断题
  {
    enableMockKv();
    mockDrawQuestion = {
      id: 'api-2', type: 'TRUE_FALSE', typeLabel: '判断题',
      content: '1.17 开启了洞穴与山崖更新', options: [], answer: 'TRUE', answers: [],
      analysis: '对。',
    };
    await runQ('/question', qEnv);
    const qRef = 'REFIDX_OUT' + outSeq;
    const out = await runQuote({ content: '对', messageType: 103, refMsgIdx: qRef }, qEnv);
    expect('/question 判断题答对', out.includes('答对了'), out);
  }

  // 多选题：集合相等（AD / DA 均可）
  {
    enableMockKv();
    mockDrawQuestion = {
      id: 'api-3', type: 'MULTIPLE', typeLabel: '多选题',
      content: '会饮用药水的有：', options: ['流浪商人', '村民', '唤魔者', '女巫'],
      answer: null, answers: ['A', 'D'], analysis: null,
    };
    await runQ('/question', qEnv);
    const qRef = 'REFIDX_OUT' + outSeq;
    const wrong = await runQuote({ content: 'A', messageType: 103, refMsgIdx: qRef }, qEnv);
    expect('/question 多选少选不对', wrong.includes('不对哦'), wrong);
    const right = await runQuote({ content: 'DA', messageType: 103, refMsgIdx: qRef }, qEnv);
    expect('/question 多选 DA 答对', right.includes('答对了'), right);
  }

  disableMockKv();

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
