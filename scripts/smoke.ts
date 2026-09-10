// 冒烟测试：钉死命令匹配 / 多级子命令 / 权限语义（不连真 QQ，桩掉 fetch）。
// 运行：npm run smoke。断言失败时退出码 1。
import { handleWebhook } from '../src/lib/handler.js';
import { commands } from '../src/lib/registry.js';
import { LEVELS } from '../src/lib/permissions.js';
import { defineCommand } from '../src/lib/define.js';

const sent: string[] = [];
const realFetch = globalThis.fetch;
// 桩掉 fetch：token 请求返回假 token，其余记录请求体里的 content（即实际发往 QQ 的回复）
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String((input as Request)?.url ?? input);
  if (url.includes('getAppAccessToken')) {
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 });
  }
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  sent.push(String((body as { content?: string }).content ?? ''));
  return new Response(JSON.stringify({ ret: 0, msg: 'ok' }), { status: 200 });
}) as typeof fetch;

// 按文档示例注册测试命令（仅本进程内，不改仓库文件）
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

function makeRequest(content: string): Request {
  const payload = {
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'ROBOT1.0_SMOKE', content, author: { user_openid: 'u_test' } },
  };
  return new Request('http://localhost/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const adminEnv = { VERIFY_EVENT_SIGNATURE: 'false', APP_ID: 'app', APP_SECRET: 'sec', SUPER_ADMIN_OPENID: 'u_test' };
const userEnv = { VERIFY_EVENT_SIGNATURE: 'false', APP_ID: 'app', APP_SECRET: 'sec' };

async function run(content: string, env: Record<string, string>): Promise<string> {
  sent.length = 0;
  await handleWebhook({ request: makeRequest(content), env });
  return sent[sent.length - 1] ?? '';
}

let fail = 0;
async function expect(label: string, content: string, env: Record<string, string>, needle: string): Promise<void> {
  const out = await run(content, env);
  const ok = out.includes(needle);
  if (!ok) fail++;
  console.log((ok ? '✓' : '✗') + ' ' + label + (ok ? '' : '  实际: ' + JSON.stringify(out)));
}

async function main(): Promise<void> {
  await expect('/game 本体', '/game', adminEnv, 'GAME_ROOT sub=null');
  await expect('/game add 命中子命令', '/game add sword', adminEnv, 'GAME_ADD sub=add args=sword');
  await expect('/game new 走别名', '/game new sword', adminEnv, 'GAME_ADD sub=add args=sword');
  await expect('/game room 分组节点回用法', '/game room', adminEnv, '用法：/game room');
  await expect('/game room 列出子命令', '/game room', adminEnv, '• /game room create — 创建房间');
  await expect('/game room create 多级命中', '/game room create r1', adminEnv, 'GAME_ROOM_CREATE sub=room create args=r1');
  await expect('/game foo bar 未命中回落主命令', '/game foo bar', adminEnv, 'GAME_ROOT sub=null args=foo,bar');
  await expect('/game add 等级1被拒', '/game add sword', userEnv, '权限不足：game add 需要等级 2');
  await expect('/game room create 等级1被拒', '/game room create r1', userEnv, '权限不足：game room create 需要等级 2');

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
