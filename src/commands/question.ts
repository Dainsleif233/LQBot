// /question —— Minecraft 知识问答：抽题 → 普通消息出题 → 引用机器人消息作答 → 答对计分。
// 主命令等级 0，群聊与私聊。题库来自 SWUSTMC API（X-API-Key = env SWUSTMC_APIKEY）。
// 会话与计分存 KV（question 命名空间）：global 存会话与 ref_idx 映射，user 存答对数。
import { LEVELS } from '../lib/permissions.js';
import { defineCommand } from '../lib/define.js';
import type { CommandContext, Config, Scene } from '../lib/types.js';

const NS = 'question';
const CATEGORY_ID = '8211471756443-023805e7';
const DRAW_URL = 'https://www.swustmc.cn/api/plugins/questionbank/draw?categoryId=' + CATEGORY_ID + '&count=1';

interface ApiQuestion {
  id: string;
  type: string; // SINGLE | MULTIPLE | TRUE_FALSE
  typeLabel: string;
  content: string;
  options?: string[];
  answer?: string | null;
  answers?: string[];
  analysis?: string | null;
  difficulty?: number;
}

interface QuestionSession {
  id: string;
  apiId: string;
  type: string;
  typeLabel: string;
  content: string;
  options: string[];
  /** 规范化正确答案：单选 ['B']；多选 ['A','D']；判断 ['TRUE'|'FALSE'] */
  correct: string[];
  analysis: string | null;
  scene: Scene;
  userOpenid: string | null;
  groupOpenid: string | null;
  askedBy: string | null;
  createdAt: number;
  done: boolean;
  attempts: number;
  /** 本会话已登记的机器人消息 REFIDX（任意一条都可被引用作答） */
  refs: string[];
}

// ---------- 答案规范化 ----------
function parseTrueFalse(text: string): 'TRUE' | 'FALSE' | null {
  const t = text.trim().toUpperCase().replace(/[。．.！!？?，,、\s]/g, '');
  if (!t) return null;
  const trueSet = new Set(['T', 'TRUE', 'Y', 'YES', '对', '正确', '是', '√', '1', 'T对', '对对']);
  const falseSet = new Set(['F', 'FALSE', 'N', 'NO', '错', '错误', '否', '×', 'X', '0', '不对']);
  if (trueSet.has(t) || /^(选)?对/.test(t) || t === '正确') return 'TRUE';
  if (falseSet.has(t) || /^(选)?错/.test(t)) return 'FALSE';
  // 单字容错：对 / 错
  if (t === '对') return 'TRUE';
  if (t === '错') return 'FALSE';
  return null;
}

/** 从用户文本提取选项字母（A-?）；无字母时按 1 基数字下标转换 */
function extractLetters(text: string, maxOpt: number): string[] {
  const up = text.toUpperCase();
  const out: string[] = [];
  for (const ch of up) {
    if (ch >= 'A' && ch <= 'Z') {
      const idx = ch.charCodeAt(0) - 65;
      if (idx >= 0 && idx < maxOpt && !out.includes(ch)) out.push(ch);
    }
  }
  if (out.length) return out;
  const nums = up.match(/\d+/g);
  if (nums) {
    for (const d of nums) {
      const n = parseInt(d, 10);
      if (n >= 1 && n <= maxOpt) {
        const L = String.fromCharCode(65 + n - 1);
        if (!out.includes(L)) out.push(L);
      }
    }
  }
  return out;
}

function isCorrectAnswer(session: QuestionSession, raw: string): boolean {
  const text = String(raw || '').trim();
  if (!text) return false;
  if (!session.correct.length) return false;
  if (session.type === 'TRUE_FALSE' || session.correct[0] === 'TRUE' || session.correct[0] === 'FALSE') {
    const v = parseTrueFalse(text);
    return v !== null && v === session.correct[0];
  }
  const maxOpt = Math.max(session.options.length, session.correct.length, 4);
  const got = extractLetters(text, maxOpt);
  if (!got.length) return false;
  if (session.correct.length === 1) {
    return got.length === 1 && got[0] === session.correct[0];
  }
  if (got.length !== session.correct.length) return false;
  const set = new Set(got);
  return session.correct.every((c) => set.has(c));
}

function normalizeCorrect(q: ApiQuestion): string[] {
  if (q.type === 'TRUE_FALSE') {
    const a = String(q.answer || '').toUpperCase();
    return [a === 'FALSE' || a === 'F' || a === '错' ? 'FALSE' : 'TRUE'];
  }
  const list = (Array.isArray(q.answers) && q.answers.length ? q.answers : (q.answer ? [q.answer] : []))
    .map((x) => String(x).trim().toUpperCase())
    .filter((x) => /^[A-Z]$/.test(x));
  return list;
}

// ---------- 出题文案（普通文本消息） ----------
const LETTERS = 'ABCDEFGH';
function formatQuestion(session: { typeLabel: string; content: string; options: string[]; type: string }): string {
  const lines = ['【' + session.typeLabel + '】' + session.content];
  session.options.forEach((opt, i) => {
    lines.push(LETTERS[i] + '. ' + opt);
  });
  if (session.type === 'TRUE_FALSE') {
    lines.push('（引用本消息回复「对」或「错」）');
  } else if (session.type === 'MULTIPLE') {
    lines.push('（多选，如 AD；引用本消息回复，可多次作答）');
  } else {
    lines.push('（引用本消息回复选项字母，如 B；可多次作答）');
  }
  return lines.join('\n');
}

// ---------- KV ----------
function newSessionId(): string {
  return 'Q-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

async function saveSession(cfg: Config, session: QuestionSession): Promise<void> {
  const ns = cfg.storage.ns(NS);
  await ns.global.setJSON('s:' + session.id, session);
}

async function loadSession(cfg: Config, id: string): Promise<QuestionSession | null> {
  return cfg.storage.ns(NS).global.getJSON<QuestionSession>('s:' + id);
}

async function bindRef(cfg: Config, refIdx: string | null, session: QuestionSession): Promise<void> {
  if (!refIdx) return;
  if (session.refs.includes(refIdx)) return;
  session.refs.push(refIdx);
  const ns = cfg.storage.ns(NS);
  await ns.global.set('ref:' + refIdx, session.id);
  await saveSession(cfg, session);
}

async function sessionByRef(cfg: Config, refIdx: string): Promise<QuestionSession | null> {
  const ns = cfg.storage.ns(NS);
  const sid = await ns.global.get('ref:' + refIdx);
  if (!sid) return null;
  return loadSession(cfg, sid);
}

async function bumpCorrectCount(cfg: Config, userOpenid: string): Promise<number> {
  const store = cfg.storage.ns(NS).user(userOpenid);
  if (!store) return 0;
  const cur = parseInt((await store.get('correct')) || '0', 10);
  const next = (Number.isFinite(cur) ? cur : 0) + 1;
  await store.set('correct', String(next));
  return next;
}

// ---------- 抽题 API ----------
async function drawQuestion(apiKey: string): Promise<ApiQuestion> {
  const resp = await fetch(DRAW_URL, {
    method: 'GET',
    headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
  });
  const text = await resp.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch (_) { data = {}; }
  if (!resp.ok) {
    throw new Error('题库 API ' + resp.status + ': ' + text.slice(0, 200));
  }
  const q = Array.isArray(data?.questions) ? data.questions[0] : null;
  if (!q || !q.content) {
    throw new Error('题库未返回题目：' + text.slice(0, 200));
  }
  return q as ApiQuestion;
}

function toSession(apiId: string, q: ApiQuestion, ctx: CommandContext): QuestionSession {
  return {
    id: newSessionId(),
    apiId: apiId || q.id || '',
    type: q.type || 'SINGLE',
    typeLabel: q.typeLabel || '问答',
    content: q.content,
    options: Array.isArray(q.options) ? q.options.map(String) : [],
    correct: normalizeCorrect(q),
    analysis: q.analysis || null,
    scene: ctx.scene,
    userOpenid: ctx.userOpenid,
    groupOpenid: ctx.groupOpenid,
    askedBy: ctx.userOpenid || ctx.memberOpenid,
    createdAt: Date.now(),
    done: false,
    attempts: 0,
    refs: [],
  };
}

// ---------- 命令 ----------
export default defineCommand({
  name: 'question',
  aliases: ['q'],
  description: 'Minecraft答题',
  minLevel: LEVELS.USER,

  async handler(ctx: CommandContext): Promise<void> {
    if (!ctx.cfg.swustmcApiKey) {
      await ctx.reply('未配置题库 API Key（SWUSTMC_APIKEY），无法抽题。');
      return;
    }
    const ns = ctx.cfg.storage.ns(NS);
    if (!ns.available) {
      await ctx.reply('KV 未绑定，答题会话不可用。');
      return;
    }
    let apiQ: ApiQuestion;
    try {
      apiQ = await drawQuestion(ctx.cfg.swustmcApiKey);
    } catch (e) {
      await ctx.reply('抽题失败：' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    const session = toSession(apiQ.id, apiQ, ctx);
    if (!session.correct.length) {
      await ctx.reply('题目数据异常（缺少标准答案），请再试一次或联系管理员。');
      return;
    }
    await saveSession(ctx.cfg, session);
    const sent = await ctx.reply(formatQuestion(session));
    await bindRef(ctx.cfg, sent.refIdx, session);
    if (!sent.refIdx) {
      console.error('[question] 发送响应缺少 ext_info.ref_idx，引用作答可能不可用 session=' + session.id);
    }
  },

  async onQuote(ctx: CommandContext): Promise<boolean | void> {
    const ns = ctx.cfg.storage.ns(NS);
    if (!ns.available) return false;
    const ref = ctx.quote?.refMsgIdx;
    if (!ref) return false;
    const session = await sessionByRef(ctx.cfg, ref);
    if (!session) return false;
    // 场景隔离：群题只在同群可答；私聊题只在同一用户
    if (session.scene !== ctx.scene) return false;
    if (ctx.scene === 'group' && session.groupOpenid && session.groupOpenid !== ctx.groupOpenid) return false;
    if (ctx.scene === 'private' && session.userOpenid && session.userOpenid !== ctx.userOpenid) return false;

    const answer = (ctx.quote?.text || '').trim();
    if (!answer) {
      await ctx.reply('请在引用里写上答案再发送（如 B / AD / 对）。');
      return true;
    }
    if (session.done) {
      await ctx.reply('这道题已经答对啦，发送 /question 再来一题。');
      return true;
    }
    session.attempts += 1;
    if (!isCorrectAnswer(session, answer)) {
      await saveSession(ctx.cfg, session);
      const sent = await ctx.reply('不对哦，再试试～（引用本题任意机器人消息作答）');
      await bindRef(ctx.cfg, sent.refIdx, session);
      return true;
    }
    session.done = true;
    await saveSession(ctx.cfg, session);
    const uid = ctx.userOpenid || ctx.memberOpenid || '';
    let n = 0;
    if (uid) n = await bumpCorrectCount(ctx.cfg, uid);
    const head = n > 0
      ? '答对了，这是你答对的第' + n + '道题'
      : '答对了';
    const tips = session.analysis ? '\n解析：' + session.analysis : '';
    await ctx.reply(head + '。' + tips);
    return true;
  },
});
