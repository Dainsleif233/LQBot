// /games —— 小游戏信息板：按日期查询 / 添加 / 删除 / 场景订阅（群聊与私聊）。
// 主命令等级 0（查询），add/del/subscribe 等级 2（全局管理员）。
// 数据存 KV（games 命名空间）：全局=游戏与订阅者索引，场景=订阅开关（只记录开）。
// 订阅通知走主动消息（无 msg_id，不占被动窗口），受 QQ 每月主动消息额度限制，失败只计数。
import { LEVELS } from '../lib/permissions.js';
import { defineCommand } from '../lib/define.js';
import type { CommandContext, Scene } from '../lib/types.js';

const NS = 'games';
const SUB_KEY = 'sub';

interface Game {
  id: string;
  createdBy: string;
  createdAt: number;
  fields: Record<string, string>;
}
interface Subscriber { scene: Scene; openid: string; }

// ---------- 日期解析（一律东八区） ----------
const CN_NUM: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s: string): number | null {
  s = s.trim();
  if (s === '十') return 10;
  const m = s.match(/^(?:([一二两三四五六七八九])?十([一二三四五六七八九])?)$/);
  if (m) {
    let v = m[1] ? CN_NUM[m[1]] : 1;
    v *= 10;
    if (m[2]) v += CN_NUM[m[2]];
    return v;
  }
  if (s.length === 1 && CN_NUM[s] !== undefined) return CN_NUM[s];
  return null;
}
function partNum(s: string): number | null {
  s = s.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return cnNum(s);
}
const DATE_PART = '[0-9〇零一二三四五六七八九十两]';
/** 解析日期参数：9.10 / 09-10 / 9/10 / 9月5日 / 九月十五号 / 9月05号 -> {month, day}（东八区） */
function parseDateArg(raw: string): { month: number; day: number } | null {
  const seg = raw.trim().match(new RegExp('^(' + DATE_PART + '{1,4})\\s*(?:[./\\-]|月)\\s*(' + DATE_PART + '{1,4})\\s*[日号]?$'));
  if (!seg) return null;
  const month = partNum(seg[1]);
  const day = partNum(seg[2]);
  if (month === null || day === null || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}
/** 当天（东八区） */
function todayCN(): { month: number; day: number } {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
/** 从自由文本（时间字段）提取 月/日：数字序列优先，其次中文/混合写法 */
function dateOfText(text: string): { month: number; day: number } | null {
  const nums = (text.match(/\d+/g) || []).map(Number);
  for (let i = 0; i + 1 < nums.length; i++) {
    if (nums[i] >= 1 && nums[i] <= 12 && nums[i + 1] >= 1 && nums[i + 1] <= 31) {
      return { month: nums[i], day: nums[i + 1] };
    }
  }
  const re = new RegExp('(' + DATE_PART + '{1,3})\\s*(?:[./\\-]|月)\\s*(' + DATE_PART + '{1,3})\\s*[日号]?', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const a = partNum(m[1]);
    const b = partNum(m[2]);
    if (a !== null && b !== null && a >= 1 && a <= 12 && b >= 1 && b <= 31) return { month: a, day: b };
  }
  return null;
}

// ---------- 字段解析（分号分隔，冒号全/半角均支持） ----------
function parseFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const seg of text.split(/[；;]/)) {
    const m = seg.match(/^\s*([^：:]{1,20}?)\s*[：:]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    if (!key || key in fields) continue;
    fields[key] = m[2].trim();
  }
  return fields;
}

// ---------- KV 存取 ----------
type Ns = ReturnType<CommandContext['cfg']['storage']['ns']>;
async function loadIndex(ctx: CommandContext): Promise<string[]> {
  const raw = await ctx.cfg.storage.ns(NS).global.get('index');
  try { const arr = JSON.parse(raw ?? '[]'); return Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === 'string') as string[] : []; }
  catch { return []; }
}
async function loadGame(ctx: CommandContext, id: string): Promise<Game | null> {
  const raw = await ctx.cfg.storage.ns(NS).global.get('g:' + id);
  if (!raw) return null;
  try { return JSON.parse(raw) as Game; } catch { return null; }
}
async function saveGame(ctx: CommandContext, game: Game, ids: string[]): Promise<void> {
  await ctx.cfg.storage.ns(NS).global.set('g:' + game.id, JSON.stringify(game));
  await ctx.cfg.storage.ns(NS).global.set('index', JSON.stringify(ids));
}
function newId(ids: string[]): string {
  for (;;) {
    const id = 'G-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    if (!ids.includes(id)) return id;
  }
}
async function subscribers(ctx: CommandContext): Promise<Subscriber[]> {
  const raw = await ctx.cfg.storage.ns(NS).global.get('subs');
  try { const arr = JSON.parse(raw ?? '[]'); return Array.isArray(arr) ? arr as Subscriber[] : []; } catch { return []; }
}

// ---------- 展示与工具 ----------
// 字段排序：名称、时间在前，其余按字段名排序（用于储存与展示）
function sortFields(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (fields['名称'] !== undefined) out['名称'] = fields['名称'];
  if (fields['时间'] !== undefined) out['时间'] = fields['时间'];
  for (const key of Object.keys(fields)
    .filter((k) => k !== '名称' && k !== '时间')
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    out[key] = fields[key];
  }
  return out;
}
function cardMarkdown(id: string, fields: Record<string, string>): string {
  const lines = ['# 🎮 ' + (fields['名称'] || '(未命名)')];
  for (const key of Object.keys(fields)) {
    if (key === '名称' || !fields[key]) continue;
    lines.push('- **' + key + '**：' + fields[key]);
  }
  lines.push('- **id**：`' + id + '`');
  return lines.join('\n');
}
function sceneKey(ctx: CommandContext): string {
  return ctx.scene === 'group' ? 'group:' + (ctx.groupOpenid || '') : 'private:' + (ctx.userOpenid || '');
}
function dateLabel(d: { month: number; day: number }, today: boolean): string {
  return (today ? '今天 ' : '') + d.month + '月' + d.day + '日';
}

export default defineCommand({
  name: 'games',
  aliases: ['game'],
  description: '小游戏列表',
  minLevel: LEVELS.USER, // 主命令：查询，等级 0

  // /games [date]：查询（date 支持多种格式，留空=当天，东八区）
  async handler(ctx: CommandContext): Promise<void> {
    const ns = ctx.cfg.storage.ns(NS);
    if (!ns.available) { await ctx.reply('KV 未绑定，小游戏列表不可用。'); return; }
    const arg = ctx.args[0];
    let target = todayCN();
    let isToday = true;
    let showAll = false;
    if (arg) {
      if (arg.toLowerCase() === 'all') {
        showAll = true;
      } else {
        const d = parseDateArg(arg);
        if (!d) {
          await ctx.reply('日期格式不支持。可用：9.10 / 09-10 / 9/10 / 9月5日 / 九月十五号 / 9月05号（一律东八区）；留空为当天；all 为今天及之后全部。');
          return;
        }
        target = d;
        isToday = false;
      }
    }
    const ids = await loadIndex(ctx);
    const games = (await Promise.all(ids.map((id) => loadGame(ctx, id)))).filter((g): g is Game => !!g);
    const matched = games.filter((g) => {
      const dt = dateOfText(g.fields['时间'] || '');
      if (!dt) return false;
      if (showAll) {
        const t = todayCN();
        return dt.month * 100 + dt.day >= t.month * 100 + t.day;
      }
      return dt.month === target.month && dt.day === target.day;
    });
    if (showAll) {
      matched.sort((a, b) => {
        const da = dateOfText(a.fields['时间'] || '');
        const db = dateOfText(b.fields['时间'] || '');
        if (!da || !db) return 0;
        return da.month * 100 + da.day - (db.month * 100 + db.day);
      });
    }
    const unknown = games.filter((g) => !dateOfText(g.fields['时间'] || ''));
    const lines = [
      showAll
        ? '# 🎮 小游戏列表（今天及之后）'
        : '# 🎮 小游戏列表（' + dateLabel(target, isToday) + '）',
    ];
    if (!matched.length) lines.push(showAll ? '今天及之后暂无小游戏。' : '该日期暂无小游戏。');
    for (const g of matched) {
      lines.push('');
      lines.push('### ' + (g.fields['名称'] || '(未命名)') + '（id：`' + g.id + '`）');
      for (const key of Object.keys(g.fields)) {
        if (key === '名称' || !g.fields[key]) continue;
        lines.push('- **' + key + '**：' + g.fields[key]);
      }
    }
    if (unknown.length) {
      lines.push('');
      lines.push('### 未标注时间的游戏');
      for (const g of unknown) lines.push('• ' + (g.fields['名称'] || g.id) + '（id：`' + g.id + '`，时间：' + (g.fields['时间'] || '未填') + '）');
    }
    await ctx.replyMarkdown(lines.join('\n'));
  },

  subcommands: [
    {
      // /games add 名称：…；主办方:…；时间：…（分号分隔、冒号全/半角均可）
      name: 'add',
      description: '添加小游戏',
      minLevel: LEVELS.GLOBAL_ADMIN, // 2
      async handler(ctx: CommandContext): Promise<void> {
        const ns = ctx.cfg.storage.ns(NS);
        if (!ns.available) { await ctx.reply('KV 未绑定，小游戏功能不可用。'); return; }
        const fields = parseFields(ctx.args.join(' '));
        // 仅「名称」「时间」必填；其余字段（主办方/版本/验证方式/地址/群聊/玩法/其他）可变可缺省
        const missing = ['名称', '时间'].filter((k) => !fields[k]);
        if (missing.length) {
          await ctx.reply('缺少必要字段：' + missing.join('、') + '。最简：\n/games add 名称：方块躲猫猫；时间：2026.9.6 晚20:00\n其余字段自定可选（格式 名称：值，分号分隔，如 主办方：江苏大学；地址：mc.jsumc.fun；玩法：XXX）。');
          return;
        }
        if (!dateOfText(fields['时间'])) {
          await ctx.reply('「时间」未识别到日期，无法按日期查询。示例：2026.9.10 / 9月10日 / 9.10。');
          return;
        }
        const sorted = sortFields(fields); // 名称、时间在前，其余按字段名排序（储存与展示一致）
        const ids = await loadIndex(ctx);
        const game: Game = { id: newId(ids), createdBy: ctx.userOpenid || '', createdAt: Date.now(), fields: sorted };
        ids.push(game.id);
        await saveGame(ctx, game, ids);
        // 通知订阅场景（主动消息）
        const note = await notify(ctx, 'md', cardMarkdown(game.id, sorted) + '\n> 📢 订阅提醒：有小游戏上架。');
        await ctx.reply('✓ 添加成功，id：`' + game.id + '`' + (note ? '\n' + note : ''));
        await ctx.replyMarkdown(cardMarkdown(game.id, sorted));
      },
    },
    {
      // /games del <id>
      name: 'del',
      description: '删除小游戏',
      minLevel: LEVELS.GLOBAL_ADMIN, // 2
      async handler(ctx: CommandContext): Promise<void> {
        const ns = ctx.cfg.storage.ns(NS);
        if (!ns.available) { await ctx.reply('KV 未绑定，小游戏功能不可用。'); return; }
        const id = (ctx.args[0] || '').trim().toUpperCase();
        if (!id) { await ctx.reply('用法：/games del <id>（id 在 /games 列表里可见）'); return; }
        const game = await loadGame(ctx, id);
        if (!game) { await ctx.reply('未找到 id：' + id); return; }
        const ids = (await loadIndex(ctx)).filter((x) => x !== id);
        await ns.global.del('g:' + id);
        await ns.global.set('index', JSON.stringify(ids));
        // 通知订阅场景（文本主动消息）
        const note = await notify(ctx, 'text', '📢 小游戏已删除：' + (game.fields['名称'] || id) + '（id：' + id + '）');
        await ctx.reply('✓ 已删除：' + (game.fields['名称'] || id) + '（' + id + '）' + (note ? '\n' + note : ''));
      },
    },
    {
      // /games subscribe：开关当前场景（群聊或私聊）的订阅；KV 只记录开
      name: 'subscribe',
      description: '开关订阅',
      minLevel: LEVELS.GLOBAL_ADMIN, // 2
      async handler(ctx: CommandContext): Promise<void> {
        const ns = ctx.cfg.storage.ns(NS);
        if (!ns.available) { await ctx.reply('KV 未绑定，小游戏功能不可用。'); return; }
        const store = ns.scene(ctx);
        if (!store) { await ctx.reply('无法确定当前场景（缺少 openid），无法订阅。'); return; }
        const cur = await store.get(SUB_KEY);
        const turningOn = cur !== '1';
        const sceneName = ctx.scene === 'group' ? '群聊' : '私聊';
        let subs = await subscribers(ctx);
        const [sType, sOpenid] = sceneKey(ctx).split(':') as [Scene, string];
        if (turningOn) {
          await store.set(SUB_KEY, '1');
          if (!subs.some((x) => x.scene === sType && x.openid === sOpenid)) subs.push({ scene: sType, openid: sOpenid });
          await ns.global.set('subs', JSON.stringify(subs));
          await ctx.reply('✓ 已开启本' + (sType === 'group' ? '群' : '会话') + '的小游戏订阅（新增/删除时收到通知）。');
        } else {
          await store.del(SUB_KEY);
          await ns.global.set('subs', JSON.stringify(subs));
          await ctx.reply('✓ 已关闭本' + (sType === 'group' ? '群' : '会话') + '的小游戏订阅。');
        }
      },
    },
  ],
});

// ---------- 订阅通知 ----------
// 通知订阅场景（主动消息，无 msg_id）：md 走 sendMarkdown；text 按场景走群/私聊文本接口。
async function notify(ctx: CommandContext, kind: 'md' | 'text', content: string): Promise<string> {
  const list = await subscribers(ctx);
  if (!list.length) return '';
  const self = sceneKey(ctx);
  let ok = 0, fail = 0;
  for (const s of list) {
    if (s.scene + ':' + s.openid === self) continue; // 自己已收到回复，不重复通知
    try {
      if (kind === 'md') await ctx.qq.sendMarkdown(ctx.cfg, s.scene, s.openid, content);
      else if (s.scene === 'group') await ctx.qq.sendGroupMessage(ctx.cfg, s.openid, content);
      else await ctx.qq.sendC2CMessage(ctx.cfg, s.openid, content);
      ok++;
    } catch (e) {
      fail++;
      console.error('[games] 通知订阅者失败：' + (e instanceof Error ? e.message : e));
    }
  }
  return '已通知订阅场景 ' + ok + ' 个' + (fail ? '（失败 ' + fail + ' 个，多为主动消息额度用尽）' : '');
}
