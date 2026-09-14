// 冒烟测试：钉死命令匹配 / 多级子命令 / 权限语义 / Markdown 与富媒体收发（不连真 QQ，桩掉 fetch）。
// 运行：npm run smoke。断言失败时退出码 1。
import { handleWebhook } from '../src/libs/handler.js';
import { commands } from '../src/libs/registry.js';
import { LEVELS } from '../src/libs/permissions.js';
import { defineCommand } from '../src/libs/define.js';
import { onRequestPost } from '../edge-functions/news.js';
import type { MessageAttachment } from '../src/libs/types.js';

interface RecordedCall { url: string; body: any; }
const calls: RecordedCall[] = [];
let outSeq = 0;
/** 为 true 时 /messages 返回 40054005（msg_seq 去重） */
let failMsgSeqDedupe = false;
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
/** jsumc /ping 的默认桩：在线、3/20、23ms */
const onlinePing = (host: string): unknown => ({
  server: host, target: host + ':25565', latency: 23,
  info: {
    version: { protocol: 773, name: 'Velocity 1.20' },
    players: { online: 3, max: 20 },
    description: { text: '测试服 ' + host },
    favicon: '',
  },
});
let mockPing: (host: string) => unknown = onlinePing;
/** 为 true 时 /ping 整体 500（模拟状态接口故障） */
let pingFail = false;
/** 交给渲染接口的 SVG 文本（每次命令执行前清空） */
const svgBodies: string[] = [];

// 桩掉 fetch：token 返回假 token；/files 返回固定 file_info；消息发送返回递增 ref_idx；题库可切换
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String((input as Request)?.url ?? input);
  // jsumc.fun 桩：/ping 按入参返回状态、/svg 只回状态码 + X-Cache-Key（命令不读 PNG 响应体）。
  // 放在 JSON.parse 之前——/svg 的 body 是裸 SVG 文本，不是 JSON。
  if (url.startsWith('https://api.jsumc.fun/ping')) {
    if (pingFail) return new Response(JSON.stringify({ error: 'ping 服务不可用' }), { status: 500 });
    const req = JSON.parse(String(init?.body || '{}')) as { servers?: string[] };
    return new Response(JSON.stringify((req.servers || []).map((h) => mockPing(h))),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.startsWith('https://api.jsumc.fun/svg')) {
    if (init?.method === 'POST') {
      svgBodies.push(String(init.body));
      // 渲染接口以响应头 X-Cache-Key 给出 cacheKey，命令据此拼 GET 图片地址
      return new Response('PNG', { status: 200, headers: { 'X-Cache-Key': 'c'.repeat(64) } });
    }
    return new Response('PNG', { status: 200 });
  }
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
    return new Response(JSON.stringify({ code: 200, message: '操作成功', data: { questions: [mockDrawQuestion], seed: '1', total: 1 } }), { status: 200 });
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
  return new Request('http://localhost/qbot', {
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
  /** 并行消息包装（parallel_message.msg_nodes），用于覆盖「真索引在节点里」的实测形态 */
  parallel?: unknown;
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
  if (opts.parallel) d.parallel_message = opts.parallel;
  const payload = { op: 0, t: isGroup ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', d };
  return new Request('http://localhost/qbot', {
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

  // QQ 40054005（msg_seq 去重）：吞掉，不向用户打「引用回复处理出错」
  {
    quoteHits.length = 0;
    failMsgSeqDedupe = true;
    const out = await runQuote({
      content: 'B',
      messageType: 103,
      refMsgIdx: 'REFIDX_QTEST',
    }, adminEnv);
    failMsgSeqDedupe = false;
    expect('40054005 不向用户暴露错误',
      quoteHits.some((h) => h.kind === 'quote') && !out.includes('引用回复处理出错') && !out.includes('40054005'),
      { quoteHits, out });
  }

  // ---------- /question ----------
  const qEnv = { ...adminEnv, SWUSTMC_APIKEY: 'test-key' };
  let qMsgSeq = 0;
  async function runQ(content: string, env: Record<string, string>): Promise<string> {
    qMsgSeq += 1;
    calls.length = 0;
    await handleWebhook({
      request: new Request('http://localhost/qbot', {
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

  // 抽题 + 普通消息出题格式（题面文本留作后续引用作答用）
  let singleMsg = '';
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
    singleMsg = out;
    const msgs = calls.filter((c) => c.url.includes('/messages'));
    expect('/question 发出 1 条出题消息', msgs.length === 1, msgs.length);
  }

  // 答错 -> 再答对（引用同一条题面）-> 计分第 1 题
  {
    // 只带被引用正文（题号在里面）+ 一个完全对不上的 msg_idx：定位不依赖任何索引
    const quoteMsg = (content: string, msg: string) => ({
      content, messageType: 103,
      elements: [{ msg_idx: 'REFIDX_IGNORED', message_type: 103, content: msg }],
    });
    const wrong = await runQuote(quoteMsg('A', singleMsg), qEnv);
    expect('/question 答错提示', wrong.includes('不对哦'), wrong);
    const right = await runQuote(quoteMsg('B', singleMsg), qEnv);
    expect('/question 答对计分', right.includes('答对了，这是你答对的第1道题') && right.includes('解析'), right);
  }

  // 答对即清理：会话删除、只留计分；之后 question 不再消费该引用
  {
    const leftovers = [...kvMap.keys()].filter((k) => k.startsWith('question:global:'));
    expect('/question 答对后清空会话', leftovers.length === 0, leftovers);
    expect('/question 答对后计分保留',
      kvMap.get('question:user:u_test:correct') === '1', kvMap.get('question:user:u_test:correct'));

    const again = await runQuote({
      content: 'B', messageType: 103,
      elements: [{ msg_idx: 'REFIDX_IGNORED', message_type: 103, content: singleMsg }],
    }, qEnv);
    // 会话已清理 → question 不再消费该引用，落到 qtest 桩的兜底回显（无会话相关回复）
    expect('/question 答对后再引用不被 question 消费',
      again.startsWith('QTEST_ANSWER') && !again.includes('答对') && !again.includes('不对哦'), again);
  }

  // 判断题
  {
    enableMockKv();
    mockDrawQuestion = {
      id: 'api-2', type: 'TRUE_FALSE', typeLabel: '判断题',
      content: '1.17 开启了洞穴与山崖更新', options: [], answer: 'TRUE', answers: [],
      analysis: '对。',
    };
    const qMsg = await runQ('/question', qEnv);
    const out = await runQuote({
      content: '对', messageType: 103,
      elements: [{ msg_idx: 'REFIDX_IGNORED', message_type: 103, content: qMsg }],
    }, qEnv);
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
    const qMsg = await runQ('/question', qEnv);
    const quoteMulti = (content: string) => ({
      content, messageType: 103,
      elements: [{ msg_idx: 'REFIDX_IGNORED', message_type: 103, content: qMsg }],
    });
    const wrong = await runQuote(quoteMulti('A'), qEnv);
    expect('/question 多选少选不对', wrong.includes('不对哦'), wrong);
    const right = await runQuote(quoteMulti('DA'), qEnv);
    expect('/question 多选 DA 答对', right.includes('答对了'), right);
  }

  // 引用定位只认题号（会话 id）：题号写在我们发出的消息文本里，随被引用正文回来；
  // 平台给的 ref_msg_idx 实测对同一条消息可能有两个值，已不作为依据
  const multiBank = {
    id: 'api-4', type: 'MULTIPLE', typeLabel: '多选题',
    content: '以下哪些方式可以扑灭营火？', options: ['用木头铲子扑灭', '投掷水瓶', '投掷雪球', '投掷风弹'],
    answer: null, answers: ['B', 'D'], analysis: null,
  };

  // ① 题号写在嵌套 msg_elements（元素套元素）里也能取到
  {
    enableMockKv();
    mockDrawQuestion = multiBank;
    const qMsg = await runQ('/question', qEnv);
    const out = await runQuote({
      content: 'BD', messageType: 103, refMsgIdx: 'REFIDX_WRAPPER1',
      elements: [
        { msg_idx: 'REFIDX_WRAPPER1', message_type: 103, content: '' },
        {
          msg_idx: 'REFIDX_X', message_type: 101, content: '',
          msg_elements: [{ msg_idx: 'REFIDX_Y', message_type: 0, content: qMsg }],
        },
      ],
    }, qEnv);
    expect('/question 嵌套元素里的题号可作答', out.includes('答对了'), out);
  }

  // ② 题号在并行消息节点（parallel_message.msg_nodes）里也能取到
  {
    enableMockKv();
    mockDrawQuestion = multiBank;
    const qMsg = await runQ('/question', qEnv);
    const out = await runQuote({
      content: 'BD', messageType: 103, refMsgIdx: 'REFIDX_WRAPPER2',
      elements: [{ msg_idx: 'REFIDX_WRAPPER2', message_type: 103, content: '@tester\n' + qMsg }],
      parallel: { msg_nodes: [{ msg_idx: 'REFIDX_X', message_type: 0, content: '@tester\n' + qMsg }] },
    }, qEnv);
    expect('/question 并行消息节点里的题号可作答', out.includes('答对了'), out);
  }

  // ④ 索引对不上且引用的是别的题：不能误判（交给后续 onQuote 兜底回显）
  {
    enableMockKv();
    mockDrawQuestion = multiBank;
    await runQ('/question', qEnv);
    const out = await runQuote({
      content: 'BD', messageType: 103, refMsgIdx: 'REFIDX_UNKNOWN2',
      elements: [{ msg_idx: 'REFIDX_UNKNOWN2', message_type: 103, content: '【多选题】另一道不相干的题\nA. 甲\nB. 乙' }],
    }, qEnv);
    expect('/question 题面不符时不误判', !out.includes('答对了') && !out.includes('不对哦'), out);
  }

  // ⑤ 答错后引用「不对哦」那条回复继续作答：回复里带题号，索引对不上也能定位回本题
  {
    enableMockKv();
    mockDrawQuestion = multiBank;
    const qMsg = await runQ('/question', qEnv);
    const wrong = await runQuote({
      content: 'A', messageType: 103, refMsgIdx: 'REFIDX_WRONG',
      elements: [{ msg_idx: 'REFIDX_WRONG', message_type: 103, content: qMsg }],
    }, qEnv);
    expect('/question 答错提示带题号', wrong.includes('不对哦') && wrong.includes('题号 Q-'), wrong);
    // 引用这条「不对哦」回复（索引同样对不上），只能靠它正文里的题号定位
    const again = await runQuote({
      content: 'BD', messageType: 103, refMsgIdx: 'REFIDX_NOPE3',
      elements: [{ msg_idx: 'REFIDX_NOPE3', message_type: 103, content: wrong }],
    }, qEnv);
    expect('/question 引用答错提示可继续作答', again.includes('答对了'), again);
  }

  // ⑥ 题号定位：题号（会话 id）随消息发出，引用时直接取回反查（这里故意只给「带题号的提示行」，
  //    题面文本不在引文里 → 指纹层无从命中，只有题号路径能救）
  {
    enableMockKv();
    mockDrawQuestion = multiBank;
    const qMsg = await runQ('/question', qEnv);
    const code = (qMsg.match(/Q-[0-9a-z]+-[0-9a-z]+/) || [])[0] || '';
    expect('/question 题面里带题号', !!code, qMsg);
    expect('/question 题号在首行', !!code && qMsg.split('\n')[0].includes(code), qMsg.split('\n')[0]);
    const out = await runQuote({
      content: 'BD', messageType: 103, refMsgIdx: 'REFIDX_NOPE4',
      elements: [{
        msg_idx: 'REFIDX_NOPE4', message_type: 103,
        content: '（多选，如 AD；引用本消息回复，可多次作答；题号 ' + code + '）',
      }],
    }, qEnv);
    expect('/question 凭题号作答（不依赖索引/指纹）', out.includes('答对了'), { code, out });
  }

  // ⑦ 作者校验：题号被用户抄进自己的消息再引用 → 不算数（元素 author.bot=false）
  {
    enableMockKv();
    mockDrawQuestion = multiBank;
    const qMsg = await runQ('/question', qEnv);
    const code = (qMsg.match(/Q-[0-9a-z]+-[0-9a-z]+/) || [])[0] || '';
    const out = await runQuote({
      content: 'BD', messageType: 103, refMsgIdx: 'REFIDX_NOPE5',
      elements: [{
        msg_idx: 'REFIDX_NOPE5', message_type: 103,
        author: { user_openid: 'u_test', bot: false },
        content: '题号 ' + code,
      }],
    }, qEnv);
    expect('/question 用户抄题号不算数（作者校验）', !out.includes('答对了') && !out.includes('不对哦'), out);
  }

  // ⑧ 只引用不写字：不回任何内容，也不消费事件（后续 onQuote 插件仍能接到），且不计入 attempts
  {
    enableMockKv();
    mockDrawQuestion = multiBank;
    const qMsg = await runQ('/question', qEnv);
    const code = (qMsg.match(/Q-[0-9a-z]+-[0-9a-z]+/) || [])[0] || '';
    const out = await runQuote({
      content: '', messageType: 103, refMsgIdx: 'REFIDX_EMPTY',
      elements: [{ msg_idx: 'REFIDX_EMPTY', message_type: 103, content: qMsg }],
    }, qEnv);
    expect('/question 空正文不回复且不消费（落到后续插件）',
      out.includes('QTEST_ANSWER') && !out.includes('请在引用里'), out);
    const sess = JSON.parse(kvMap.get('question:global:s:' + code) || '{}');
    expect('/question 空正文不计 attempts', sess.attempts === 0, sess.attempts);
  }

  disableMockKv();

  // ---------- /games ----------
  // 东八区今天/明天，用于钉死日期过滤
  function cnToday(): { month: number; day: number; label: string } {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    return { month, day, label: month + '.' + day };
  }
  function cnTomorrow(): { month: number; day: number; label: string } {
    const d = new Date(Date.now() + 8 * 3600 * 1000 + 86400000);
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    return { month, day, label: month + '.' + day };
  }
  function messageBodies(): string[] {
    return calls
      .filter((c) => c.url.includes('/messages'))
      .map((c) => String(c.body?.content ?? c.body?.markdown?.content ?? ''));
  }
  let gMsgSeq = 0;
  async function runG(content: string, env: Record<string, string> = adminEnv): Promise<string[]> {
    gMsgSeq += 1;
    calls.length = 0;
    await handleWebhook({
      request: new Request('http://localhost/qbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 0,
          t: 'C2C_MESSAGE_CREATE',
          d: { id: 'ROBOT1.0_G' + gMsgSeq, content, author: { user_openid: 'u_test' } },
        }),
      }),
      env,
    });
    return messageBodies();
  }
  function expectG(label: string, bodies: string[], needle: string): void {
    const ok = bodies.some((b) => b.includes(needle));
    if (!ok) fail++;
    console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : '  实际: ' + JSON.stringify(bodies)));
  }
  /** 群聊 AT 消息（超管身份），返回本次发出的消息体 */
  async function runGroup(content: string, groupOpenid: string, msgId: string): Promise<string[]> {
    calls.length = 0;
    await handleWebhook({
      request: new Request('http://localhost/qbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 0,
          t: 'GROUP_AT_MESSAGE_CREATE',
          d: {
            id: msgId,
            content,
            group_openid: groupOpenid,
            author: { member_openid: 'u_admin', username: 'admin', member_role: 'admin' },
          },
        }),
      }),
      env: { ...adminEnv, SUPER_ADMIN_OPENID: 'u_admin' },
    });
    return messageBodies();
  }

  // KV 未绑定
  {
    const bodies = await runG('/games');
    expectG('/games KV 未绑定提示', bodies, 'KV 未绑定');
  }

  enableMockKv();

  // 空列表
  {
    const bodies = await runG('/games');
    expectG('/games 空列表标题', bodies, '# 🎮 小游戏列表（今天 ');
    expectG('/games 空列表文案', bodies, '该日期暂无小游戏。');
  }

  // 日期格式非法
  {
    const bodies = await runG('/games 昨天');
    expectG('/games 非法日期提示', bodies, '日期格式不支持');
  }

  // add 缺字段 / 时间无法解析 / 权限不足
  {
    const bodies = await runG('/games add 主办方：测试');
    expectG('/games add 缺名称时间', bodies, '缺少必要字段');
  }
  {
    const bodies = await runG('/games add 名称：X；时间：随便');
    expectG('/games add 时间无法解析', bodies, '「时间」未识别到日期');
  }
  {
    const bodies = await runG('/games add 名称：X；时间：9.10', userEnv);
    expectG('/games add 等级1被拒', bodies, '权限不足：games add 需要等级 2');
  }

  // add 成功：文本 id + Markdown 卡片；字段排序 名称/时间在前
  let addedId = '';
  const today = cnToday();
  {
    const bodies = await runG('/games add 名称：方块躲猫猫；时间：' + today.label + ' 晚20:00；主办方：江苏大学；地址：mc.jsumc.fun');
    const text = bodies.find((b) => b.includes('✓ 添加成功')) || '';
    const card = bodies.find((b) => b.includes('# 🎮 方块躲猫猫')) || '';
    const m = text.match(/id：`([^`]+)`/);
    addedId = m ? m[1] : '';
    expect('/games add 成功文本+id', !!m && /^G-[A-Z0-9]{5}$/.test(addedId), bodies);
    expect('/games add Markdown 卡片字段',
      card.includes('- **时间**：' + today.label + ' 晚20:00')
      && card.includes('- **主办方**：江苏大学')
      && card.includes('- **地址**：mc.jsumc.fun')
      && card.includes('- **id**：`' + addedId + '`')
      && card.indexOf('**时间**') < card.indexOf('**地址**')
      && card.indexOf('**地址**') < card.indexOf('**主办方**'),
      card);
  }

  // 冒号全半角混用 + 查当天
  {
    await runG('/games add 名称:混用冒号；时间：' + today.label);
    const bodies = await runG('/games');
    expectG('/games 查当天含方块躲猫猫', bodies, '### 方块躲猫猫（id：`' + addedId + '`）');
    expectG('/games 查当天含混用冒号', bodies, '### 混用冒号（id：');
    expect('/games 条目为三级标题', bodies.some((b) => b.includes('### 方块躲猫猫')), bodies);
  }

  // 按指定日期查询（今天）
  {
    const bodies = await runG('/games ' + today.label);
    expectG('/games 按日期查中', bodies, '方块躲猫猫');
    expect('/games 按日期标题无「今天」',
      bodies.some((b) => b.includes('（' + today.month + '月' + today.day + '日）') && !b.includes('今天 ')),
      bodies);
  }

  // all：含今天与明天，不含过去
  const tomorrow = cnTomorrow();
  {
    await runG('/games add 名称：明日场；时间：' + tomorrow.label);
    // 过去日期：1.1，仅当今天不是 1.1 时才有意义
    if (!(today.month === 1 && today.day === 1)) {
      await runG('/games add 名称：过去场；时间：1.1');
    }
    const bodies = await runG('/games all');
    expectG('/games all 标题', bodies, '# 🎮 小游戏列表（今天及之后）');
    expectG('/games all 含今天', bodies, '方块躲猫猫');
    expectG('/games all 含明天', bodies, '明日场');
    if (!(today.month === 1 && today.day === 1)) {
      expect('/games all 不含过去场', !bodies.some((b) => b.includes('过去场')), bodies);
    }
    // 升序：明天场应出现在今天场之后
    const joined = bodies.join('\n');
    const iToday = joined.indexOf('方块躲猫猫');
    const iTomorrow = joined.indexOf('明日场');
    expect('/games all 按日期升序', iToday >= 0 && iTomorrow > iToday, { iToday, iTomorrow });
  }

  // edit：用法 / 未找到 / 权限 / 时间非法 / 改值与删字段（独立条目，不影响其它用例的断言）
  let editId = '';
  {
    const created = await runG('/games add 名称：编辑场；时间：' + today.label + '；地址：old.example.com');
    const m = (created.find((b) => b.includes('✓ 添加成功')) || '').match(/id：`([^`]+)`/);
    editId = m ? m[1] : '';
    expect('/games edit 前置条目创建', !!editId, created);
  }
  {
    const usage = await runG('/games edit');
    expectG('/games edit 缺参数提示用法', usage, '用法：/games edit <id>');
    const noId = await runG('/games edit 名称：X');
    expectG('/games edit 缺 id 提示用法', noId, '用法：/games edit <id>');
    const miss = await runG('/games edit G-NOPE 名称：X');
    expectG('/games edit 未找到 id', miss, '未找到 id：G-NOPE');
    const denied = await runG('/games edit G-NOPE 名称：X', userEnv);
    expectG('/games edit 等级1被拒', denied, '权限不足：games edit 需要等级 2');
    const badTime = await runG('/games edit ' + editId + ' 时间：随便');
    expectG('/games edit 时间无法解析', badTime, '「时间」未识别到日期');
    const blankName = await runG('/games edit ' + editId + ' 名称：');
    expectG('/games edit 名称不可置空', blankName, '「名称」不能为空');
  }
  if (editId) {
    // 覆盖已有字段 + 新增字段；未给出的字段保持原值
    const bodies = await runG('/games edit ' + editId + ' 地址：mc2.jsumc.fun；玩法：晚八点集合');
    expectG('/games edit 成功文本', bodies, '✓ 已修改：编辑场（' + editId + '）');
    expectG('/games edit 变更字段列表', bodies, '变更：地址、玩法');
    const card = bodies.find((b) => b.includes('# 🎮 编辑场')) || '';
    expect('/games edit 卡片覆盖+排序',
      card.includes('- **时间**：' + today.label)
      && card.includes('- **地址**：mc2.jsumc.fun')
      && card.includes('- **玩法**：晚八点集合')
      && card.indexOf('**时间**') < card.indexOf('**地址**'), card);

    // 值未变化时不写 KV，直接提示
    const same = await runG('/games edit ' + editId + ' 地址：mc2.jsumc.fun');
    expectG('/games edit 值相同不写', same, '字段值与当前一致，未做修改。');

    // 值留空 = 删除该字段
    const cleared = await runG('/games edit ' + editId + ' 玩法：');
    expectG('/games edit 空值删字段', cleared, '变更：玩法');
    const list = await runG('/games ' + today.label);
    const editedCard = list.find((b) => b.includes('编辑场')) || '';
    expect('/games edit 删除后不显示该字段', !editedCard.includes('晚八点集合'), list);
  }

  // del
  {
    const miss = await runG('/games del G-NOPE');
    expectG('/games del 未找到', miss, '未找到 id：G-NOPE');
    if (addedId) {
      const ok = await runG('/games del ' + addedId);
      expectG('/games del 成功', ok, '✓ 已删除：方块躲猫猫（' + addedId + '）');
      const after = await runG('/games');
      expect('/games 删除后列表不含', !after.some((b) => b.includes('方块躲猫猫')), after);
    }
  }

  // subscribe 开关（私聊）
  {
    const on = await runG('/games subscribe');
    expectG('/games subscribe 开启', on, '✓ 已开启本会话的小游戏订阅');
    const off = await runG('/games subscribe');
    expectG('/games subscribe 关闭', off, '✓ 已关闭本会话的小游戏订阅');
  }

  // 群订阅 + 私聊 add → 主动通知该群
  {
    enableMockKv();
    gMsgSeq += 1;
    await handleWebhook({
      request: new Request('http://localhost/qbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 0,
          t: 'GROUP_AT_MESSAGE_CREATE',
          d: {
            id: 'ROBOT1.0_GSUB',
            content: '/games subscribe',
            group_openid: 'g_sub',
            author: { member_openid: 'u_admin', username: 'admin', member_role: 'admin' },
          },
        }),
      }),
      env: { ...adminEnv, SUPER_ADMIN_OPENID: 'u_admin' },
    });
    expectG('/games 群 subscribe', messageBodies(), '已开启本群的小游戏订阅');

    calls.length = 0;
    const added = await runG('/games add 名称：群通知场；时间：' + tomorrow.label, adminEnv);
    const notifyMsg = calls.find((c) => c.url.includes('/messages') && c.url.includes('g_sub'));
    expect('/games add 通知订阅群',
      !!notifyMsg && String(notifyMsg.body?.markdown?.content ?? '').includes('群通知场')
      && String(notifyMsg.body?.markdown?.content ?? '').includes('订阅提醒'),
      notifyMsg);

    // edit 同样通知订阅场景，并带上变更字段
    const noticeId = ((added.find((b) => b.includes('✓ 添加成功')) || '').match(/id：`([^`]+)`/) || [])[1] || '';
    calls.length = 0;
    const edited = await runG('/games edit ' + noticeId + ' 地址：gsub.example.com', adminEnv);
    const editNotify = calls.find((c) => c.url.includes('/messages') && c.url.includes('g_sub'));
    const editMd = String(editNotify?.body?.markdown?.content ?? '');
    expect('/games edit 通知订阅群',
      !!noticeId && !!editNotify && editMd.includes('群通知场')
      && editMd.includes('小游戏信息有更新') && editMd.includes('变更：地址')
      && editMd.includes('- **地址**：gsub.example.com'),
      editNotify);
    expectG('/games edit 回复带通知计数', edited, '已通知订阅场景 1 个');
  }

  // 退订（群）：回归——曾只删场景开关、没摘全局索引，退订后照旧收到通知
  {
    expectG('/games 群退订', await runGroup('/games subscribe', 'g_sub', 'ROBOT1.0_GUNSUB'), '已关闭本群的小游戏订阅');
    calls.length = 0;
    await runG('/games add 名称：退订后场；时间：' + tomorrow.label, adminEnv);
    expect('/games 退订后不再通知该群',
      !calls.some((c) => c.url.includes('/messages') && c.url.includes('g_sub')), calls);

    // 索引条目即订阅状态：有本场景条目 = 已订阅，一次 /games subscribe 即退订（旧版本只删开关、留下索引的残留数据同样按此处理）
    kvMap.set('games:global:subs', JSON.stringify([{ scene: 'group', openid: 'g_legacy' }]));
    expectG('/games 残留索引视为已订阅', await runGroup('/games subscribe', 'g_legacy', 'ROBOT1.0_GOFF1'), '已关闭本群的小游戏订阅');
    calls.length = 0;
    await runG('/games add 名称：残留索引场；时间：' + tomorrow.label, adminEnv);
    expect('/games 残留索引退订后不通知',
      !calls.some((c) => c.url.includes('/messages') && c.url.includes('g_legacy')), calls);
  }

  // ---------- /server ----------
  let srvSeq = 0;
  /** 私聊执行 /server（超管身份，等级 3）；返回本次发出的消息文本 */
  async function runSrv(content: string, env: Record<string, string> = adminEnv): Promise<string[]> {
    srvSeq += 1;
    calls.length = 0;
    svgBodies.length = 0;
    await handleWebhook({
      request: new Request('http://localhost/qbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 0,
          t: 'C2C_MESSAGE_CREATE',
          d: { id: 'ROBOT1.0_SRV' + srvSeq, content, author: { user_openid: 'u_test' } },
        }),
      }),
      env,
    });
    return messageBodies();
  }
  /** 群聊执行 /server（指定 member_role；超管仍设为 u_admin，测试用例里用 u_member） */
  async function runGroupAs(content: string, groupOpenid: string, msgId: string, role: string): Promise<string[]> {
    calls.length = 0;
    svgBodies.length = 0;
    await handleWebhook({
      request: new Request('http://localhost/qbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 0,
          t: 'GROUP_AT_MESSAGE_CREATE',
          d: {
            id: msgId,
            content,
            group_openid: groupOpenid,
            author: { member_openid: 'u_member', username: 'member', member_role: role },
          },
        }),
      }),
      env: { ...adminEnv, SUPER_ADMIN_OPENID: 'u_admin' },
    });
    return messageBodies();
  }
  /** 最近一次富媒体发送（msg_type=7）与其上传来源（/files 的 file_type + url） */
  function lastMedia(): { fileInfo?: string; uploadUrl?: string; fileType?: number } {
    const msg = [...calls].reverse().find((c) => c.url.includes('/messages') && c.body?.msg_type === 7);
    const up = [...calls].reverse().find((c) => c.url.includes('/files'));
    return { fileInfo: msg?.body?.media?.file_info, uploadUrl: up?.body?.url, fileType: up?.body?.file_type };
  }

  // KV 未绑定（前面的 /games 用例还开着内存 KV，先关掉）
  {
    disableMockKv();
    const bodies = await runSrv('/server');
    expectG('/server KV 未绑定提示', bodies, 'KV 未绑定');
  }

  enableMockKv();

  // 空列表
  {
    const bodies = await runSrv('/server');
    expectG('/server 空列表提示', bodies, '还没有添加服务器');
  }

  // add：参数与地址校验
  {
    expectG('/server add 缺参数回用法', await runSrv('/server add'), '用法：/server add <地址> [位置]');
    expectG('/server add 地址非法', await runSrv('/server add bad/addr'), '地址格式不对');
    expectG('/server add 位置非数字', await runSrv('/server add mc.test.cn x'), '位置要写正整数');
    expectG('/server add 位置越界', await runSrv('/server add mc.test.cn 9'), '位置超出范围');
  }

  // add：成功（含探测）/ 重复 / 指定位置 / KV 落点
  {
    const bodies = await runSrv('/server add mc.test.cn');
    expectG('/server add 成功', bodies, '✓ 已添加 mc.test.cn（第 1 位，共 1 台）');
    expectG('/server add 带探测结果', bodies, '探测：在线 3/20，延迟 23ms，版本 Velocity 1.20');
    expectG('/server add 回执带列表', bodies, '1. mc.test.cn');
    expectG('/server add 重复提示', await runSrv('/server add mc.test.cn'), '已在列表里（第 1 位）');
    const ins = await runSrv('/server add a.example.com 1');
    expectG('/server add 指定位置', ins, '✓ 已添加 a.example.com（第 1 位，共 2 台）');
    expect('/server add 指定位置顺序', /1\. a\.example\.com\n2\. mc\.test\.cn/.test(ins.join('\n')), ins);
    expect('/server 列表存用户场景', kvMap.get('server:user:u_test:list') === JSON.stringify(['a.example.com', 'mc.test.cn']),
      kvMap.get('server:user:u_test:list'));
  }

  // 列表图片：POST /svg 拿 cacheKey -> 用 GET 地址上传 -> msg_type=7 发送
  {
    const bodies = await runSrv('/server');
    const media = lastMedia();
    expect('/server 列表出图', media.fileInfo === 'FI_SMOKE' && media.fileType === 1 &&
      /^https:\/\/api\.jsumc\.fun\/svg\?key=c{64}$/.test(media.uploadUrl || ''), media);
    expect('/server 列表图含两台服务器',
      svgBodies.length === 1 && svgBodies[0].includes('a.example.com') && svgBodies[0].includes('mc.test.cn')
      && svgBodies[0].includes('服务器列表') && !svgBodies[0].includes('@font-face'), svgBodies.map((s) => s.length));
    expect('/server 列表不再发文字', bodies.every((b) => b === ''), bodies);
  }

  // 单台查询：带参数出单卡，不带列表标题
  {
    await runSrv('/server mc.test.cn');
    const media = lastMedia();
    expect('/server <地址> 出单卡图', media.fileType === 1 &&
      /^https:\/\/api\.jsumc\.fun\/svg\?key=c{64}$/.test(media.uploadUrl || ''), media);
    expect('/server <地址> SVG 只含这一台',
      svgBodies.length === 1 && svgBodies[0].includes('mc.test.cn') && !svgBodies[0].includes('a.example.com')
      && !svgBodies[0].includes('服务器列表'), svgBodies[0]?.length);
  }

  // 离线服务器照常出图（无法连接）
  {
    mockPing = (host) => ({ server: host, error: 'connect timeout' });
    await runSrv('/server down.example.com');
    expect('/server 离线也出图', svgBodies.length === 1 && svgBodies[0].includes('无法连接'), svgBodies[0]?.slice(0, 120));
    mockPing = onlinePing;
  }

  // 传统 § 代码的 MOTD（部分服务端回纯字符串而不是 JSON 组件，如 mod.jsumc.fun）：颜色要还原、§ 不能漏进图
  {
    mockPing = (host) => ({
      server: host, target: host + ':25565', latency: 12,
      info: {
        version: { protocol: 773, name: '1.21.1' },
        players: { online: 1, max: 20 },
        // 第一行：§2 深绿 / §e 黄 / §6 金；第二行：§b 青 + §k 混淆、§a 绿，末尾接 Bungee 十六进制色 §x§F§F§0§0§0§0
        description: '§2江苏大学§eMinecraft§6同好会\n§b§k----§a模组服§b----§x§F§F§0§0§0§0端',
      },
    });
    await runSrv('/server mod.test.cn');
    const svg = svgBodies[0] || '';
    expect('/server § 代码还原颜色（含 §x 十六进制）',
      svg.includes('>江苏大学<') && svg.includes('fill="#00AA00"') && svg.includes('fill="#FFFF55"')
      && svg.includes('fill="#FFAA00"') && svg.includes('fill="#55FFFF"') && svg.includes('fill="#FF0000"')
      && !svg.includes('§'),
      svg.slice(0, 300));
    mockPing = onlinePing;
  }

  // 状态接口整体故障：文字报错、不出图
  {
    pingFail = true;
    const bodies = await runSrv('/server');
    expectG('/server 接口故障提示', bodies, '获取服务器状态失败');
    expect('/server 接口故障不出图', svgBodies.length === 0, svgBodies.length);
    pingFail = false;
  }

  // del：未命中 / 越界 / 按地址 / 按位置
  {
    expectG('/server del 未命中', await runSrv('/server del nope.example.com'), '列表里没有 nope.example.com');
    expectG('/server del 位置越界', await runSrv('/server del 9'), '位置超出范围');
    expectG('/server del 按地址', await runSrv('/server del mc.test.cn'), '✓ 已删除 mc.test.cn（原第 2 位，剩 1 台）');
    expectG('/server del 按位置', await runSrv('/server del 1'), '✓ 已删除 a.example.com（原第 1 位，剩 0 台）');
    expect('/server 删空后 KV 为空数组', kvMap.get('server:user:u_test:list') === '[]', kvMap.get('server:user:u_test:list'));
  }

  // 权限：群聊普通成员（等级 0）不能增删，查询不受影响
  {
    const denied = await runGroupAs('/server add mc.test.cn', 'g_srv', 'ROBOT1.0_SRVG1', 'member');
    expect('/server add 群成员被拒', denied.some((b) => b.includes('权限不足：server add 需要等级 1')), denied);
    const deniedDel = await runGroupAs('/server del mc.test.cn', 'g_srv', 'ROBOT1.0_SRVG2', 'member');
    expect('/server del 群成员被拒', deniedDel.some((b) => b.includes('权限不足：server del 需要等级 1')), deniedDel);
    const query = await runGroupAs('/server', 'g_srv', 'ROBOT1.0_SRVG3', 'member');
    expectG('/server 查询对群成员开放', query, '本群还没有添加服务器');
  }

  // 群聊与私聊的列表互相隔离
  {
    const added = await runGroupAs('/server add g.example.com', 'g_srv', 'ROBOT1.0_SRVG4', 'admin');
    expectG('/server 群聊添加成功', added, '✓ 已添加 g.example.com（第 1 位，共 1 台）');
    expect('/server 群列表存群场景', kvMap.get('server:group:g_srv:list') === JSON.stringify(['g.example.com']),
      kvMap.get('server:group:g_srv:list'));
    const priv = await runSrv('/server');
    expectG('/server 私聊看不到群列表', priv, '本会话还没有添加服务器');
  }

  // ---------- /news（新闻推送：命令订阅 + POST /news webhook 鉴权/推送） ----------
  // 源侧密钥（环境变量 SWUSTMC_NEWS）与载荷形态按实测钉死
  const newsEnv = { ...adminEnv, SWUSTMC_NEWS: 'news-secret' };
  function newsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      event: 'mc.news.new',
      title: 'Minecraft 测试版本发布',
      url: 'https://example.com/news/1',
      content: '## Minecraft 测试版本发布\n\n正文内容。',
      summary: '摘要',
      sourceName: 'Minecraft 官网新闻',
      publishedAt: '2026-09-14T17:12:20.576Z',
      timestamp: 1789406006464,
      ...overrides,
    };
  }
  async function postNews(body: unknown, opts: { secret?: string | null; env?: Record<string, string>; raw?: string } = {}): Promise<any> {
    calls.length = 0;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.secret !== null) headers['x-secret'] = opts.secret ?? 'news-secret';
    const resp = await onRequestPost({
      request: new Request('http://localhost/news', {
        method: 'POST',
        headers,
        body: opts.raw === undefined ? JSON.stringify(body) : opts.raw,
      }),
      env: opts.env ?? newsEnv,
    });
    const text = await resp.text();
    return { status: resp.status, json: text ? JSON.parse(text) : {}, sent: calls.filter((c) => c.url.includes('/messages')) };
  }

  // 未配置 SWUSTMC_NEWS：fail-closed，拒绝一切推送
  {
    const r = await postNews(newsPayload(), { env: { ...adminEnv } });
    expect('/news 未配置 SWUSTMC_NEWS 时拒绝推送', r.status === 500 && r.sent.length === 0, r);
  }

  // x-secret 错误 / 缺失
  {
    const wrong = await postNews(newsPayload({ url: 'https://example.com/news/11' }), { secret: 'nope' });
    expect('/news x-secret 错误返回 401 且不推送', wrong.status === 401 && wrong.sent.length === 0, wrong);
    const missing = await postNews(newsPayload({ url: 'https://example.com/news/12' }), { secret: null });
    expect('/news 缺少 x-secret 返回 401', missing.status === 401, missing);
  }

  // 鉴权通过但无人订阅：正常 200、零发送
  {
    const r = await postNews(newsPayload({ url: 'https://example.com/news/13' }));
    expect('/news 无订阅者时零发送', r.status === 200 && r.json.sent === 0 && r.sent.length === 0, r);
  }

  // 命令：等级 0 被拒；超管可开订阅
  {
    const denied = await runG('/news', userEnv);
    expectG('/news 普通用户被拒', denied, '权限不足：news 需要等级 2');
  }
  {
    const on = await runG('/news');
    expectG('/news 私聊开启订阅', on, '✓ 已开启本会话的新闻推送订阅');
    expect('/news 订阅落 KV news:global:subs',
      kvMap.get('news:global:subs') === JSON.stringify([{ scene: 'private', openid: 'u_test' }]),
      kvMap.get('news:global:subs'));
  }
  {
    const bodies = await runGroup('/news', 'g_news', 'ROBOT1.0_NEWSG1');
    expectG('/news 群聊开启订阅', bodies, '✓ 已开启本群的新闻推送订阅');
    const subs = JSON.parse(kvMap.get('news:global:subs') || '[]');
    expect('/news 订阅索引同时含群与私聊',
      subs.length === 2 && subs.some((s: any) => s.scene === 'group' && s.openid === 'g_news'), subs);
  }

  // 推送：群与私聊各收到一条 Markdown（主动消息，无 msg_id，msg_type=2）
  {
    const r = await postNews(newsPayload({ url: 'https://example.com/news/14' }));
    const groupCall = r.sent.find((c: RecordedCall) => c.url.includes('/v2/groups/g_news/messages'));
    const userCall = r.sent.find((c: RecordedCall) => c.url.includes('/v2/users/u_test/messages'));
    expect('/news 推送覆盖群与私聊各一条', r.status === 200 && r.sent.length === 2 && !!groupCall && !!userCall,
      r.sent.map((c: RecordedCall) => c.url));
    expect('/news 推送正文取 content 字段',
      r.sent.every((c: RecordedCall) => String(c.body?.markdown?.content ?? '') === String(newsPayload().content)),
      r.sent.map((c: RecordedCall) => c.body?.markdown?.content));
    expect('/news 推送走主动消息（无 msg_id）',
      r.sent.every((c: RecordedCall) => !c.body?.msg_id && c.body?.msg_type === 2),
      r.sent.map((c: RecordedCall) => c.body));
    expect('/news 响应统计 sent=2/received=1', r.json.sent === 2 && r.json.received === 1, r.json);
  }

  // 无去重：同一 url 再推一次照常发送
  {
    const r = await postNews(newsPayload({ url: 'https://example.com/news/14' }));
    expect('/news 同一 url 重复推送照常发送',
      r.status === 200 && r.json.sent === 2 && r.sent.length === 2, r.json);
  }

  // 一次多篇（数组载荷）：逐篇处理，每篇推给全部订阅场景
  {
    const r = await postNews([
      newsPayload({ url: 'https://example.com/news/15', title: '第二篇' }),
      newsPayload({ url: 'https://example.com/news/15', title: '第二篇（同 url 重复）' }),
    ]);
    expect('/news 数组载荷逐篇处理（2 篇 × 2 场景）',
      r.status === 200 && r.json.received === 2 && r.json.sent === 4 && r.sent.length === 4, r.json);
  }

  // content 缺失：用标题/摘要/原文链接兜底
  {
    const r = await postNews({ event: 'mc.news.new', title: '无正文新闻', url: 'https://example.com/news/16', summary: '只有摘要' });
    const md = String(r.sent[0]?.body?.markdown?.content ?? '');
    expect('/news content 缺失时兜底拼接 Markdown',
      r.sent.length === 2 && md.indexOf('# 无正文新闻') === 0 && md.includes('只有摘要') && md.includes('https://example.com/news/16'), md);
  }

  // 非法 JSON / 空体
  {
    const bad = await postNews(null, { raw: 'not-json' });
    expect('/news 非法 JSON 返回 400', bad.status === 400 && bad.sent.length === 0, bad);
    const empty = await postNews(null, { raw: '' });
    expect('/news 空体返回 400', empty.status === 400, empty);
  }

  // 关闭订阅：索引清空且不再推送
  {
    await runG('/news');
    await runGroup('/news', 'g_news', 'ROBOT1.0_NEWSG2');
    const subs = JSON.parse(kvMap.get('news:global:subs') || '[]');
    expect('/news 两端关闭后订阅索引为空', subs.length === 0, subs);
    const r = await postNews(newsPayload({ url: 'https://example.com/news/17' }));
    expect('/news 无人订阅时不再推送', r.status === 200 && r.sent.length === 0 && r.json.sent === 0, r.json);
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
