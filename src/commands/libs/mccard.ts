// /server 的卡片渲染：把服务器 ping 数据画成 Minecraft 原版「多人游戏」列表风格的 SVG。
//
// 版式、折行与度量逻辑移植自 mc-server-cards 项目（scripts/render/v1-ingame.mjs + scripts/lib/minecraft.js），
// 只有两处差别：
//   1. 字体度量取 src/commands/libs/mcfont.ts 的烘焙表（边缘运行时读不到字体文件，度量必须内置）；
//   2. 每张卡片在 MOTD 下面多一行小字显示服务器地址（同一群里几台服务器的 MOTD 可能很像，靠地址区分）。
//
// SVG 里**不内嵌字体**：没有 @font-face、没有 url()、没有字形数据，只有 font-family 名字
// （Mojangles = "Minecraft Seven"，缺字回退 "Unifont"）——字形由渲染器按 fontKey 提供。
import { MOJANGLES, UNIFONT, hasMojanglesGlyph, mojanglesAdvance, unifontAdvance } from './mcfont.js';
import type { PingResult } from './jsumc.js';

// ---------------------------------------------------------------------------
//  渲染模型
// ---------------------------------------------------------------------------

/** 一段带样式的文本（MOTD 组件树拍平后的结果） */
export interface Run {
  text: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
}

/** 一台服务器的状态（渲染输入）：ok=false 时只有 host 与 error 有意义 */
export interface McServer {
  host: string;
  ok: boolean;
  error: string | null;
  online: number;
  max: number;
  latency: number | null;
  versionName: string;
  target: string | null;
  favicon: string | null;
  motdLines: Run[][];
  plainLines: string[];
}

/** 渲染结果：SVG 文本 + 画布尺寸（宽度要原样交给渲染接口，否则会被缩到默认 800） */
export interface SvgImage {
  svg: string;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
//  MOTD：Minecraft 聊天组件树 -> 带样式的文本片段
// ---------------------------------------------------------------------------

const NAMED_COLORS: Record<string, string> = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
  dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
  dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
  red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF',
};
const STYLE_KEYS = ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'] as const;

const DEFAULT_STYLE: Run = {
  text: '', color: '#FFFFFF', bold: false, italic: false,
  underlined: false, strikethrough: false, obfuscated: false,
};

function normalizeColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'reset') return 'reset';
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (!hex) return null;
  const h = hex[1];
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return '#' + full.toUpperCase();
}

/** 合并样式/附加字段（tokenizeRun、wrapRuns 会在此基础上挂 space/breakable/x/width 等临时字段） */
function mergeStyle<T extends object, P extends object>(base: T, patch: P): T & P {
  return Object.assign({}, base, patch) as T & P;
}

/**
 * 传统 § 代码（1.0 之前就有的那套）。接口对不同服务器返回的 MOTD 形态不一样：
 * 有的给 JSON 聊天组件（{"extra":[...]}），有的直接给带 § 代码的纯字符串
 * （如 mod.jsumc.fun："§2江苏大学§eMinecraft…"），两种都要还原成同样的样式片段。
 */
const LEGACY_COLOR_NAMES: Record<string, string> = {
  '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua',
  '4': 'dark_red', '5': 'dark_purple', '6': 'gold', '7': 'gray',
  '8': 'dark_gray', '9': 'blue', a: 'green', b: 'aqua',
  c: 'red', d: 'light_purple', e: 'yellow', f: 'white',
};
/** §k-§o 是样式、§r 复位（颜色回白，五种样式全清，与原版一致） */
const LEGACY_STYLE_CODES: Record<string, Partial<Run>> = {
  k: { obfuscated: true }, l: { bold: true }, m: { strikethrough: true }, n: { underlined: true }, o: { italic: true },
  r: { color: '#FFFFFF', bold: false, italic: false, underlined: false, strikethrough: false, obfuscated: false },
};

/** §x 后接 6 组 §<hex>：BungeeCord / Velocity 扩展的 RGB 颜色（§x§r§r§g§g§b§b） */
function readLegacyHex(text: string, i: number): { color: string; next: number } | null {
  let hex = '#';
  let j = i + 2;
  for (let k = 0; k < 6; k++) {
    if (text[j] !== '§' || !/[0-9a-fA-F]/.test(text[j + 1] || '')) return null;
    hex += text[j + 1];
    j += 2;
  }
  return { color: hex.toUpperCase(), next: j };
}

/**
 * 把一段文本按 § 代码切成带样式的片段（原版的分解规则）：
 * 有效代码切换样式并从文本里删掉；无效代码只丢掉 §、后面的字符照常当正文。
 */
function pushStyledText(text: string, style: Run, out: Run[]): void {
  if (!text) return;
  let cur = style;
  let buf = '';
  const flush = (): void => { if (buf) { out.push(mergeStyle(cur, { text: buf })); buf = ''; } };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '§') { buf += ch; continue; }
    if (i + 1 >= text.length) break; // 结尾孤立的 § 直接丢掉
    const code = text[i + 1].toLowerCase();
    if (code === 'x') {
      const hex = readLegacyHex(text, i);
      if (hex) { flush(); cur = mergeStyle(cur, { color: hex.color }); i = hex.next - 1; continue; }
    }
    const colorName = LEGACY_COLOR_NAMES[code];
    const patch: Partial<Run> | undefined = colorName ? { color: NAMED_COLORS[colorName] } : LEGACY_STYLE_CODES[code];
    if (!patch) continue; // 无效代码：丢掉 §，下一个字符按正文处理
    flush();
    cur = mergeStyle(cur, patch);
    i += 1;
  }
  flush();
}

function plainText(node: unknown): string {
  return flattenComponent(node, DEFAULT_STYLE, []).map((r) => r.text).join('');
}

function flattenComponent(node: unknown, inherited: Run, out: Run[]): Run[] {
  if (typeof node === 'string') node = { text: node };
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenComponent(item, inherited, out);
    return out;
  }
  if (typeof node !== 'object') { pushStyledText(String(node), inherited, out); return out; }
  const n = node as Record<string, unknown>;

  let style = inherited;
  if (typeof n.color === 'string') {
    const c = normalizeColor(n.color);
    if (c === 'reset') {
      const reset: Partial<Run> = { color: '#FFFFFF' };
      for (const s of STYLE_KEYS) reset[s] = false;
      style = mergeStyle(style, reset);
    } else if (c) {
      style = mergeStyle(style, { color: c });
    }
  }
  const overrides: Partial<Run> = {};
  let touched = false;
  for (const key of STYLE_KEYS) {
    if (typeof n[key] === 'boolean') { overrides[key] = n[key] as boolean; touched = true; }
  }
  if (touched) style = mergeStyle(style, overrides);

  let text = '';
  if (typeof n.text === 'string') text = n.text;
  else if (typeof n.translate === 'string') {
    const args = Array.isArray(n.with) ? (n.with as unknown[]).map(plainText) : [];
    let idx = 0;
    text = n.translate.replace(/%((\d+)\$)?s/g, () => (idx < args.length ? args[idx++] : '%s'));
    if (text === n.translate && args.length) text = [n.translate, ...args].join(' ');
  } else if (typeof n.keybind === 'string') text = n.keybind;
  else if (typeof n.selector === 'string') text = n.selector;

  if (text) pushStyledText(text, style, out);

  if (Array.isArray(n.extra)) for (const e of n.extra) flattenComponent(e, style, out);
  return out;
}

/** 解析 MOTD：拍平组件树，再按文本里的换行切成多行 */
function parseMotd(description: unknown): { runs: Run[]; lines: Run[][]; plain: string } {
  const flat = flattenComponent(description, DEFAULT_STYLE, []);
  const lines: Run[][] = [[]];
  for (const run of flat) {
    const parts = String(run.text).split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) lines.push([]);
      if (parts[p] !== '') lines[lines.length - 1].push(mergeStyle(run, { text: parts[p] }));
    }
  }
  const cleaned = lines.filter((l) => l.length > 0);
  return {
    runs: flat,
    lines: cleaned.length ? cleaned : [[]],
    plain: flat.map((r) => r.text).join(''),
  };
}

/** 去掉行尾空白（MOTD 常用空格对齐，尾部空格会撑宽排版） */
function trimLine(runs: Run[]): Run[] {
  const out = runs.map((r) => mergeStyle(r, {}));
  while (out.length) {
    const last = out[out.length - 1];
    const t = last.text.replace(/\s+$/, '');
    if (t === '') out.pop();
    else { last.text = t; break; }
  }
  return out;
}

/**
 * 把接口返回的原始 JSON 归一化成渲染模型。
 * 离线（接口只回 error）时给一个「无法连接」的单行 MOTD，卡片照常画出来。
 */
export function toServer(host: string, raw: PingResult | null | undefined): McServer {
  const info = raw && raw.info;
  if (!info) {
    const err = (raw && (raw.error || raw.message)) || '无法连接';
    return {
      host, ok: false, error: err,
      online: 0, max: 0, latency: null, versionName: '未知', target: null, favicon: null,
      motdLines: [[{ text: '无法连接', color: '#FF5555' }]],
      plainLines: ['无法连接'],
    };
  }
  const parsed = parseMotd(info.description);
  const lines = parsed.lines.map(trimLine).filter((l) => l.length);
  const players = info.players || {};
  const version = info.version || {};
  return {
    host,
    ok: true,
    error: null,
    online: typeof players.online === 'number' ? players.online : 0,
    max: typeof players.max === 'number' ? players.max : 0,
    latency: raw && typeof raw.latency === 'number' ? raw.latency : null,
    versionName: version.name || '未知',
    target: raw && typeof raw.target === 'string' ? raw.target : null,
    favicon: typeof info.favicon === 'string' ? info.favicon : null,
    motdLines: lines.length ? lines : [[{ text: '', color: '#FFFFFF' }]],
    plainLines: (lines.length ? lines : [[]]).map((l) => l.map((r) => r.text).join('')),
  };
}

/** 数据快照时间（东八区，秒级不需要；用于列表页脚） */
export function snapshotTime(d: Date = new Date()): string {
  const cn = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate()) +
    ' ' + p(cn.getUTCHours()) + ':' + p(cn.getUTCMinutes());
}

// ---------------------------------------------------------------------------
//  字体度量与分段排版
// ---------------------------------------------------------------------------

/** 传给引擎度量挂钩的标识（这里直接测量，不再经过挂钩） */
const FONT_KEY = 'mcfont';
/** 原版文字阴影偏移 */
const SHADOW_PX = 2;

/**
 * 拉丁档字号倍率。
 * Minecraft Seven 的大写高只有 0.7em，而 Unifont 的中文字形几乎撑满整个 em：
 * 同号渲染时中文墨迹 28~30px、拉丁大写只有 22px，放在一起明显「中文大、英文小」。
 * 乘上这个倍率把两边视觉高度拉齐（实测：拉丁大写高从 22px 提到约 25.5px）。
 */
const LATIN_SCALE = 1.16;

/** 某个字体在该档字号下实际使用的 font-size */
function sizeFor(family: string, baseSize: number): number {
  return family === MOJANGLES.family ? baseSize * LATIN_SCALE : baseSize;
}

/** 基础字间距，按字体分别设（拉丁的乘 LATIN_SCALE，字号变了间距跟着走） */
const LETTER_SPACING: Record<string, number> = { [MOJANGLES.family]: 2.6 * LATIN_SCALE, [UNIFONT.family]: 2 };

/**
 * 逐字符推进补偿（像素）。
 * Minecraft Seven 的 '-' 只有 0.40em、空格 0.30em，而旧位图字体两者分别是 0.75em / 0.50em
 * （相对大写高的比例）。不补的话 MOTD 里的连字符分隔线会短一截。数字是**乘 LATIN_SCALE 之前**的基础值。
 */
const ADVANCE_FIX: Record<string, number> = { '-': 5.17 * LATIN_SCALE, ' ': 3 * LATIN_SCALE };

/** 三档字号（这是中文件的字号，拉丁按 LATIN_SCALE 单独放大） */
const SIZE = { title: 48, body: 32, small: 20 };

/** 行高与基线：Unifont 上伸部 56/64 em，中文字形撑满整个 em */
const LH = 36;
const ASCENT_PX = Math.round((UNIFONT.ascender / UNIFONT.unitsPerEm) * SIZE.body);
const DESCENT_PX = Math.round((-UNIFONT.descender / UNIFONT.unitsPerEm) * SIZE.body);

/** 复刻浏览器的字体回退：Mojangles 有字形就用它，否则 Unifont */
function familyOf(cp: number): string {
  return hasMojanglesGlyph(cp) ? MOJANGLES.family : UNIFONT.family;
}

/** 该码位在当前字体下的推进宽度（像素） */
function advancePx(cp: number, size: number): number {
  return hasMojanglesGlyph(cp) ? mojanglesAdvance(cp) * size : unifontAdvance(cp) * size;
}

/** 某个字符的总间距 = 该字体的基础字间距 + 逐字符补偿 */
function spacingOf(cp: number): number {
  return LETTER_SPACING[familyOf(cp)] + (ADVANCE_FIX[String.fromCodePoint(cp)] || 0);
}

/** 精确宽度（像素）：逐字符累加真实推进 + 间距；拉丁用放大后的字号 */
function measurePx(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    w += advancePx(cp, sizeFor(familyOf(cp), size)) + spacingOf(cp);
  }
  return w;
}

function escapeXml(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function round(n: number): number { return Math.round(n * 100) / 100; }

/** 按比例压暗颜色（原版文字阴影 = 颜色 x 0.25） */
function darken(hex: string, factor: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  if (!m) return '#3F3F3F';
  const out = [m[1], m[2], m[3]].map((c) => Math.round(Number('0x' + c) * factor).toString(16).padStart(2, '0'));
  return '#' + out.join('').toUpperCase();
}

/** 延迟 -> 信号格数 / 颜色（沿用原版分级：150/300/600/1000ms） */
export function pingTier(latency: number | null): { bars: number; color: string; label: string } {
  if (latency === null || latency === undefined || !isFinite(latency) || latency < 0) {
    return { bars: 0, color: '#FF5555', label: '离线' };
  }
  if (latency <= 150) return { bars: 5, color: '#3FE04A', label: '良好' };
  if (latency <= 300) return { bars: 4, color: '#7FE04A', label: '正常' };
  if (latency <= 600) return { bars: 3, color: '#FFE04A', label: '一般' };
  if (latency <= 1000) return { bars: 2, color: '#FFA83F', label: '较差' };
  return { bars: 1, color: '#FF5555', label: '很差' };
}

/** 原版风格 ping 信号格：x/y 为左下角 */
function pingBarsSvg(x: number, y: number, opts: {
  bars: number; color: string; count?: number; barWidth: number; gap: number; minHeight: number; maxHeight: number;
}): string {
  const total = opts.count === undefined ? 5 : opts.count;
  const offColor = '#3A3A3A';
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    const h = opts.minHeight + (opts.maxHeight - opts.minHeight) * (i / (total - 1));
    out.push('<rect x="' + round(x + i * (opts.barWidth + opts.gap)) + '" y="' + round(y - h) +
      '" width="' + opts.barWidth + '" height="' + round(h) + '" fill="' + (i < opts.bars ? opts.color : offColor) + '"/>');
  }
  return out.join('');
}

/** 用 <image> 嵌入服务端图标；没有 favicon 就画一个程序生成的草方块 */
function faviconSvg(favicon: string | null, x: number, y: number, size: number): string {
  if (favicon && /^data:image\//.test(favicon)) {
    return '<image x="' + x + '" y="' + y + '" width="' + size + '" height="' + size +
      '" href="' + escapeXml(favicon) + '" preserveAspectRatio="xMidYMid meet"' +
      ' image-rendering="pixelated" style="image-rendering:pixelated"/>';
  }
  return grassBlockSvg(x, y, size);
}

/** 程序生成的草方块（16x16 像素风）：没有 favicon 时的诚实兜底 */
function grassBlockSvg(x: number, y: number, size: number): string {
  const px = size / 16;
  const out = ['<g transform="translate(' + round(x) + ',' + round(y) + ')">'];
  out.push('<rect width="' + size + '" height="' + size + '" fill="#7B5A3A"/>');
  let seed = 1337;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      const v = rnd();
      if (v < 0.28) out.push('<rect x="' + round(i * px) + '" y="' + round(j * px) + '" width="' + round(px) + '" height="' + round(px) + '" fill="#6B4A2E"/>');
      else if (v > 0.86) out.push('<rect x="' + round(i * px) + '" y="' + round(j * px) + '" width="' + round(px) + '" height="' + round(px) + '" fill="#8B6A46"/>');
    }
  }
  out.push('<rect width="' + size + '" height="' + round(px * 3.6) + '" fill="#5BA83F"/>');
  for (let k = 0; k < 16; k++) {
    const h = rnd() < 0.5 ? 4 : 5;
    out.push('<rect x="' + round(k * px) + '" y="' + round(px * 3) + '" width="' + round(px) + '" height="' + round(px * (h - 3)) + '" fill="#5BA83F"/>');
  }
  out.push('<rect y="' + round(px * 3.6) + '" width="' + size + '" height="' + round(px * 0.6) + '" fill="#4A8C33"/>');
  out.push('</g>');
  return out.join('');
}

// ---------------------------------------------------------------------------
//  富文本折行：把样式片段流按可用宽度切成「定位好的行」
// ---------------------------------------------------------------------------

/** 已定位的一行：runs 里带 x 与 width */
export interface LaidLine { width: number; runs: Array<Run & { x: number; width: number }>; }

interface Token extends Run { space: boolean; breakable: boolean; }

function sameStyle(a: Run, b: Run): boolean {
  return a.color === b.color && a.bold === b.bold && a.italic === b.italic &&
    a.underlined === b.underlined && a.strikethrough === b.strikethrough && a.obfuscated === b.obfuscated;
}

function tokenizeRun(run: Run): Token[] {
  const tokens: Token[] = [];
  let buf = '';
  const chars = Array.from(run.text);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ') {
      if (buf) { tokens.push(mergeStyle(run, { text: buf, space: false, breakable: false })); buf = ''; }
      let sp = '';
      while (i < chars.length && chars[i] === ' ') { sp += ' '; i++; }
      i--;
      tokens.push(mergeStyle(run, { text: sp, space: true, breakable: true }));
    } else buf += ch;
  }
  if (buf) tokens.push(mergeStyle(run, { text: buf, space: false, breakable: false }));
  return tokens;
}

/** 宽字符判定（CJK 等）：中文可在字间断行 */
function isWideCode(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115F || (code >= 0x2E80 && code <= 0xA4CF) ||
    (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE30 && code <= 0xFE6F) || (code >= 0xFF00 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) || (code >= 0x20000 && code <= 0x3FFFD)
  );
}

export interface WrapOptions {
  fontSize: number;
  maxWidth?: number;
  maxLines?: number;
}

/**
 * 折行：按空格与 CJK 字间断行；超宽的单行会截断并补省略号。
 * 返回的行里每个 run 都带 x（行内偏移）与 width。
 */
export function wrapRuns(runs: Run[], opts: WrapOptions): LaidLine[] {
  const fontSize = opts.fontSize;
  const maxWidth = opts.maxWidth === undefined ? Infinity : opts.maxWidth;
  const maxLines = opts.maxLines || Infinity;

  let tokens: Token[] = [];
  for (const run of runs) tokens = tokens.concat(tokenizeRun(run));

  // 断行许可：前一个字符是空格、行首、或两侧都是 CJK 时才允许，避免把 "Union登入" 这类视觉连写的词劈开
  let prevChar = '';
  for (const t of tokens) {
    if (t.space) { t.breakable = true; if (t.text) prevChar = ' '; continue; }
    const firstCh = t.text.charAt(0);
    t.breakable = prevChar === '' || prevChar === ' ' ||
      (isWideCode(prevChar.codePointAt(0) as number) && isWideCode(firstCh.codePointAt(0) as number));
    prevChar = t.text.charAt(t.text.length - 1) || prevChar;
  }

  const lines: LaidLine[] = [];
  let cur: LaidLine = { width: 0, runs: [] };
  let truncated = false;
  const pushLine = (): void => { lines.push(cur); cur = { width: 0, runs: [] }; };
  const append = (run: Run, text: string, width: number): void => {
    const last = cur.runs[cur.runs.length - 1];
    if (last && sameStyle(last, run)) { last.text += text; last.width += width; }
    else cur.runs.push(mergeStyle(run, { text, width, x: 0 }));
    cur.width += width;
  };
  const mw = (text: string): number => measurePx(text, fontSize);

  for (const tok of tokens) {
    const w = mw(tok.text);
    if (tok.space) {
      if (cur.width === 0) continue;
      append(tok, tok.text, w);
      continue;
    }
    if (cur.width + w <= maxWidth || cur.width === 0 || !tok.breakable) {
      if (w > maxWidth && cur.width === 0) {
        for (const ch of Array.from(tok.text)) {
          const cw = mw(ch);
          if (cur.width + cw > maxWidth && cur.width > 0) pushLine();
          append(tok, ch, cw);
        }
        continue;
      }
      append(tok, tok.text, w);
    } else {
      pushLine();
      if (lines.length >= maxLines) { truncated = true; break; }
      const trimmed = tok.text.replace(/^\s+/, '');
      append(tok, trimmed, mw(trimmed));
    }
  }
  if (cur.runs.length || lines.length === 0) pushLine();

  const out = lines.slice(0, maxLines === Infinity ? lines.length : maxLines);
  if (truncated && out.length) {
    const lastLine = out[out.length - 1];
    const tail = lastLine.runs[lastLine.runs.length - 1] || DEFAULT_STYLE;
    lastLine.runs.push(mergeStyle(tail, { text: '…', width: mw('…'), x: 0 }));
  }
  for (const line of out) {
    let x = 0;
    for (const run of line.runs) { run.x = x; x += run.width; }
    line.width = x;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  行 -> SVG
// ---------------------------------------------------------------------------

interface LineSvgOptions {
  x: number;
  y: number;
  size: number;
  anchor?: 'start' | 'middle' | 'end';
  shadow?: number;
}

/**
 * 渲染一个已排好版的行。
 * 按 (字体, 字间距) 把行切成若干段，每段一个 <text>，段起点 x 由我们自己算，接缝和整体对齐都是精确的。
 */
function lineSvg(line: LaidLine, o: LineSvgOptions): string {
  if (!line || !line.runs.length) return '';
  const dx = o.anchor === 'middle' ? -line.width / 2 : (o.anchor === 'end' ? -line.width : 0);
  const shadow = o.shadow || 0;
  const out: string[] = [];
  for (const isShadow of (shadow ? [true, false] : [false])) {
    let cursor = o.x + dx;
    for (const run of line.runs) {
      const fill = isShadow ? darken(run.color || '#FFFFFF', 0.25) : (run.color || '#FFFFFF');
      let seg: { family: string; spacing: number; size: number; x: number; text: string } | null = null;
      const flush = (): void => {
        if (!seg || !seg.text) { seg = null; return; }
        const ox = seg.x + (isShadow ? shadow : 0);
        const oy = o.y + (isShadow ? shadow : 0);
        // xml:space 只在段落含连续空白或首尾空白时才需要（默认会折叠空白）
        const preserve = /^\s|\s$|\s\s/.test(seg.text) ? ' xml:space="preserve"' : '';
        out.push('<text x="' + round(ox) + '" y="' + round(oy) + '" font-family="' + seg.family +
          '" font-size="' + round(seg.size) + '" font-kerning="none"' +
          (seg.spacing ? ' letter-spacing="' + round(seg.spacing) + '"' : '') +
          ' fill="' + fill + '"' + preserve + '>' + escapeXml(seg.text) + '</text>');
        seg = null;
      };
      for (const ch of run.text) {
        const cp = ch.codePointAt(0) as number;
        const family = familyOf(cp);
        const spacing = spacingOf(cp);
        // letter-spacing 是元素级属性，间距不同的字符必须拆到不同的 <text>
        if (!seg || seg.family !== family || seg.spacing !== spacing) {
          flush();
          seg = { family, spacing, size: sizeFor(family, o.size), x: cursor, text: '' };
        }
        seg.text += ch;
        cursor += advancePx(cp, seg.size) + spacing;
      }
      flush();
    }
  }
  return out.join('\n');
}

/** 单行 / 多行文本（自动折行、支持居中与右对齐，并画原版阴影） */
function mcText(runs: Run[], opts: {
  x: number; baseline: number; size: number; maxWidth?: number; maxLines?: number;
  lineHeight?: number; anchor?: 'start' | 'middle' | 'end'; shadow?: boolean;
}): string {
  const lines = wrapRuns(runs, {
    fontSize: opts.size,
    maxWidth: opts.maxWidth === undefined ? Infinity : opts.maxWidth,
    maxLines: opts.maxLines || 1,
  });
  const lineHeight = opts.lineHeight || LH;
  return lines.map((line, i) => lineSvg(line, {
    x: opts.x,
    y: opts.baseline + i * lineHeight,
    size: opts.size,
    anchor: opts.anchor,
    shadow: opts.shadow === false ? 0 : SHADOW_PX,
  })).join('\n');
}

/** 文本宽度（像素） */
function mcWidth(text: string, size: number): number { return measurePx(text, size); }

// ---------------------------------------------------------------------------
//  卡片几何与内容
// ---------------------------------------------------------------------------

/** 卡片左侧那条色条的颜色（固定，不随 MOTD 变） */
const ACCENT_COLOR = '#3FE04A';
/** 地址行：小字灰色，放在 MOTD 下方 */
const HOST_COLOR = '#9A9A9A';
const HOST_LINE_H = 27;

/** 卡片各部尺寸；原点在卡片左上角 */
const CARD = {
  padX: 22,            // 卡片左内边距
  iconSize: 72,
  iconGap: 22,         // 图标到文字的间距
  padTop: 20,
  padBottom: 20,
  motdMargin: 28,      // MOTD 右边界到人数左边界的距离
  maxMotdWidth: 1000,  // MOTD 不折行的宽度上限，超过就折行
  latencyWidth: 78,    // 延迟文字预留宽度
  countGap: 24,        // 人数与延迟之间的距离
  rightPad: 16,        // 右栏到卡片右边界
  bars: { barWidth: 5, gap: 3, minHeight: 5, maxHeight: 18 },
};
/** 卡片正文起始 x（图标右侧） */
const TEXT_X = CARD.padX + CARD.iconSize + CARD.iconGap;

/** 人数文本的最大宽度（列表里要取全体最大值才能纵向对齐） */
function countWidthOf(servers: McServer[]): number {
  return Math.ceil(Math.max(...servers.map((s) => mcWidth(s.online + '/' + s.max, SIZE.body))));
}

/** MOTD 不折行时的自然宽度（取前两行的最大值） */
function naturalMotdWidth(server: McServer): number {
  return Math.max(...server.motdLines.slice(0, 2).map((line) => mcWidth(line.map((r) => r.text).join(''), SIZE.body)));
}

/**
 * 由「MOTD 自然宽度 + 人数宽度 + 地址宽度」推出卡片几何；宽度刚好裹住内容，右边不留多余空白。
 * 地址行比 MOTD 宽时按地址算宽度（否则长域名会顶出卡片），但 MOTD 的折行宽度仍以 motdWrap 为准。
 */
function cardGeometry(naturalMotd: number, countWidth: number, hostWidth: number): {
  width: number; motdWrap: number; countRightEdge: number; rightRight: number; barsX: number;
} {
  const motdWrap = Math.min(Math.ceil(naturalMotd) + 1, CARD.maxMotdWidth);
  const textBlock = Math.max(motdWrap, Math.ceil(hostWidth));
  const width = Math.ceil(TEXT_X + textBlock + CARD.motdMargin + countWidth + CARD.countGap + CARD.latencyWidth + CARD.rightPad);
  const barsWidth = 5 * CARD.bars.barWidth + 4 * CARD.bars.gap;
  return {
    width,
    motdWrap,
    countRightEdge: width - CARD.rightPad - CARD.latencyWidth - CARD.countGap,
    rightRight: width - CARD.rightPad,
    barsX: width - CARD.rightPad - barsWidth,
  };
}

/** 折行：最多两行源文本，每行再折 2，最后截到 3 行 */
function wrapMotd(server: McServer, maxWidth: number): LaidLine[] {
  const lines: LaidLine[] = [];
  server.motdLines.slice(0, 2).forEach((line) => {
    wrapRuns(line, { fontSize: SIZE.body, maxWidth, maxLines: 2 }).forEach((l) => { if (l.runs.length) lines.push(l); });
  });
  if (lines.length > 2) {
    const widest = Math.max(...lines.map((l) => l.width));
    console.warn('[mccard] ' + server.host + ' 的 MOTD 需要折行（最宽 ' + Math.round(widest) + 'px / 可用 ' + Math.round(maxWidth) + 'px）');
  }
  return lines.slice(0, 3);
}

/** 卡片高度由 MOTD 行数决定（再加一行地址） */
function cardHeight(lineCount: number): number {
  return CARD.padTop + ASCENT_PX + (lineCount - 1) * LH + HOST_LINE_H + DESCENT_PX + CARD.padBottom;
}

/**
 * 单张卡片的 SVG 片段。
 * origin = 卡片左上角在画布中的位置；height = 卡片高度。
 * withBackground = true 时在卡片下方铺一层泥土背景（单卡片独立成图时用，保证观感和列表里一致）。
 */
function cardSvg(
  server: McServer,
  geo: ReturnType<typeof cardGeometry>,
  lines: LaidLine[],
  origin: { x: number; y: number },
  height: number,
  withBackground: boolean,
): string {
  const x = origin.x, y = origin.y, w = geo.width;
  const tier = pingTier(server.latency);
  const baseline1 = y + CARD.padTop + ASCENT_PX;
  const g: string[] = [];

  if (withBackground) {
    g.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + height + '" fill="url(#dirt)"/>');
    g.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + height + '" fill="#000000" opacity="0.76"/>');
  }

  // 卡片底：半透明黑 + 1px 黑边 + 顶部一线高光
  // 描边内缩 0.5px 并开 crispEdges：黑边完整落在卡片范围内，画布边缘不会漏出半像素，也不会糊成 2px。
  g.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + height + '" fill="#000000" opacity="0.55"/>');
  g.push('<rect x="' + (x + 0.5) + '" y="' + (y + 0.5) + '" width="' + (w - 1) + '" height="' + (height - 1) +
    '" fill="none" stroke="#000000" stroke-width="1" shape-rendering="crispEdges"/>');
  g.push('<rect x="' + (x + 1) + '" y="' + (y + 1) + '" width="' + (w - 2) + '" height="1" fill="#FFFFFF" opacity="0.05"/>');
  // 左侧色条
  g.push('<rect x="' + (x + 1) + '" y="' + (y + 1) + '" width="3" height="' + (height - 2) + '" fill="' + ACCENT_COLOR + '"/>');

  // 服务端图标（外圈两道黑框）
  const iconX = x + CARD.padX;
  const iconY = y + (height - CARD.iconSize) / 2;
  g.push('<rect x="' + (iconX - 2) + '" y="' + (iconY - 2) + '" width="' + (CARD.iconSize + 4) + '" height="' + (CARD.iconSize + 4) + '" fill="#000000"/>');
  g.push('<rect x="' + (iconX - 1) + '" y="' + (iconY - 1) + '" width="' + (CARD.iconSize + 2) + '" height="' + (CARD.iconSize + 2) + '" fill="#1A1A1A"/>');
  g.push(faviconSvg(server.favicon, iconX, iconY, CARD.iconSize));

  // MOTD
  lines.forEach((line, li) => {
    g.push(lineSvg(line, { x: x + TEXT_X, y: baseline1 + li * LH, size: SIZE.body, shadow: SHADOW_PX }));
  });

  // 地址行（小字）：几个服务器的 MOTD 可能很像，靠地址区分
  g.push(mcText([{ text: server.host, color: HOST_COLOR }], {
    x: x + TEXT_X,
    baseline: baseline1 + (lines.length - 1) * LH + HOST_LINE_H,
    size: SIZE.small,
    lineHeight: 22,
    shadow: false,
  }));

  // 右栏：人数在左、延迟在右；延迟上数字、下五格信号
  const mid = y + height / 2;
  const base = mid - 2;
  const countColor = server.max > 0 && server.online >= server.max ? '#FF5555' : '#FFFFFF';
  g.push(mcText([{ text: server.online + '/' + server.max, color: countColor }],
    { x: x + geo.countRightEdge, baseline: base, size: SIZE.body, lineHeight: LH, anchor: 'end' }));
  g.push(mcText([{ text: (server.latency === null ? '--' : server.latency) + 'ms', color: '#A8A8A8' }],
    { x: x + geo.rightRight, baseline: base, size: SIZE.small, lineHeight: 22, anchor: 'end' }));
  g.push(pingBarsSvg(x + geo.barsX, base + 26, Object.assign({ bars: tier.bars, color: tier.color }, CARD.bars)));

  return g.join('\n');
}

/**
 * 程序生成的泥土纹理。
 * 先按固定随机序列生成 16x16 色格，再把同行同色的格子合并成游程、按颜色各写成一条 <path>——
 * 256 个 <rect> 要 14 KB，7 条 path 只要 1.5 KB，渲染结果逐像素相同。
 */
function dirtPattern(id = 'dirt', seed = 20260913): string {
  let s = seed >>> 0;
  const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const palette = ['#866043', '#79553A', '#6E4C34', '#8B6A4A', '#5E4129', '#7A5738', '#6A4A2F'];

  const grid: string[][] = [];
  for (let y = 0; y < 16; y++) {
    const row: string[] = [];
    for (let x = 0; x < 16; x++) row.push(palette[Math.floor(rnd() * palette.length)]);
    grid.push(row);
  }

  const byColor = new Map<string, string[]>();
  grid.forEach((row, y) => {
    let x = 0;
    while (x < 16) {
      const color = row[x];
      let len = 1;
      while (x + len < 16 && row[x + len] === color) len++;
      if (!byColor.has(color)) byColor.set(color, []);
      (byColor.get(color) as string[]).push('M' + x + ' ' + y + 'h' + len + 'v1h-' + len + 'z');
      x += len;
    }
  });

  const paths = [...byColor].map(([color, d]) => '<path fill="' + color + '" d="' + d.join('') + '"/>').join('');
  return '<pattern id="' + id + '" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="scale(4)" shape-rendering="crispEdges">' + paths + '</pattern>';
}

/**
 * SVG 根元素。只留渲染必需的东西：没有 <title>/<desc>，也没有 role/aria-label——
 * 这份 SVG 只是交给渲染接口换成 PNG 的中间产物，不面向人类阅读也不做无障碍。
 */
function svgOpen(width: number, height: number): string {
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
    '" viewBox="0 0 ' + width + ' ' + height + '">'].join('\n');
}

/** 渲染接口的画布上限：换算后的 width/height 必须落在 16~4096（实测超出直接 400） */
const MAX_CANVAS = 4096;

// ---------------------------------------------------------------------------
//  产物一：单台服务器的卡片
// ---------------------------------------------------------------------------

/**
 * 渲染**一台**服务器的卡片，画布尺寸正好等于卡片本身——四周没有透明像素。
 * 几何只按这一台的内容算，所以不同服务器的卡片宽度会不一样。
 */
export function renderCard(server: McServer): SvgImage {
  const geo = cardGeometry(naturalMotdWidth(server), countWidthOf([server]), mcWidth(server.host, SIZE.small));
  const lines = wrapMotd(server, geo.motdWrap);
  const height = cardHeight(lines.length);
  const w = geo.width, h = height;
  const svg = [svgOpen(w, h),
    '<defs>' + dirtPattern() + '</defs>',
    cardSvg(server, geo, lines, { x: 0, y: 0 }, height, true),
    '</svg>', ''].join('\n');
  return { svg, width: w, height: h };
}

// ---------------------------------------------------------------------------
//  产物二：列表（标题 + 若干卡片 + 页脚）
// ---------------------------------------------------------------------------

export interface ListOptions {
  /** 页脚数据快照时间（东八区），缺省取当前时间 */
  stamp?: string;
  /** 标题，缺省「服务器列表」 */
  title?: string;
  /**
   * 列表总台数（可能大于传进来的 servers.length）。
   * 画不下的台数会在页脚右侧标注「仅显示前 N 台（共 M 台）」。
   */
  total?: number;
}

/** 渲染服务器列表：多台服务器纵向排列，各行 MOTD 与右栏对齐 */
export function renderList(servers: McServer[], opts: ListOptions = {}): SvgImage {
  const stamp = opts.stamp || snapshotTime();
  const title = opts.title || '服务器列表';
  const rowX = 32, gap = 12;
  const listTop = 120;
  const footerH = 72;

  // 列表里各行的 MOTD 区域与右栏必须对齐，所以几何取全体最宽的一行
  const geo = cardGeometry(
    Math.max(...servers.map(naturalMotdWidth)),
    countWidthOf(servers),
    Math.max(...servers.map((s) => mcWidth(s.host, SIZE.small))),
  );
  const layout = servers.map((s) => {
    const lines = wrapMotd(s, geo.motdWrap);
    return { server: s, lines, height: cardHeight(lines.length) };
  });

  // 渲染接口的画布上限是 4096（换算后的 height 超出直接 400），所以按实际卡片高度累加，
  // 装不下的台数不画，页脚标注只显示了前几台。
  const budget = MAX_CANVAS - listTop - footerH;
  let used = 0;
  let count = 0;
  for (const item of layout) {
    const step = item.height + (count ? gap : 0);
    if (count > 0 && used + step > budget) break;
    used += step;
    count += 1;
  }
  const shown = layout.slice(0, count);
  const ys: number[] = [];
  let y = listTop;
  for (const item of shown) { ys.push(y); y += item.height + gap; }
  const w = geo.width + rowX * 2;
  const h = listTop + used + footerH;

  const body: string[] = [];
  body.push('<rect width="' + w + '" height="' + h + '" fill="url(#dirt)"/>');
  body.push('<rect width="' + w + '" height="' + h + '" fill="#000000" opacity="0.76"/>');

  // 标题 / 副标题
  body.push(mcText([{ text: title, color: '#FFFFFF' }],
    { x: w / 2, baseline: 60, size: SIZE.title, lineHeight: 56, anchor: 'middle', maxWidth: w - 80 }));
  body.push(mcText([{ text: '数据源：', color: '#9A9A9A' }, { text: 'api.jsumc.fun', color: '#B8B8B8' }],
    { x: w / 2, baseline: 100, size: SIZE.small, lineHeight: 22, anchor: 'middle', maxWidth: w - 80 }));

  // 卡片
  shown.forEach((item, i) => {
    body.push(cardSvg(item.server, geo, item.lines, { x: rowX, y: ys[i] }, item.height, false));
  });

  // 页脚：左边数据快照，右边「只显示了前几台」的标注
  body.push(mcText([{ text: '数据快照：' + stamp, color: '#8A8A8A' }],
    { x: rowX, baseline: h - 28, size: SIZE.small, lineHeight: 22, maxWidth: w - rowX * 2 }));
  const totalCount = opts.total === undefined ? servers.length : opts.total;
  if (totalCount > shown.length) {
    body.push(mcText([{ text: '仅显示前 ' + shown.length + ' 台（共 ' + totalCount + ' 台）', color: '#8A8A8A' }],
      { x: w - rowX, baseline: h - 28, size: SIZE.small, lineHeight: 22, anchor: 'end', maxWidth: (w - rowX * 2) / 2 }));
  }

  const svg = [svgOpen(w, h),
    '<defs>' + dirtPattern() + '</defs>',
    body.join('\n'),
    '</svg>', ''].join('\n');
  return { svg, width: w, height: h };
}

export default renderList;
