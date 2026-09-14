// 生成 src/commands/libs/mcfont.ts：把字体文件里的排版度量（cmap 码位覆盖 + hmtx 推进宽度）烘焙成常量表。
//
// 为什么要烘焙：SVG 里只写 font-family（不内嵌字形、也不引用字体文件），字形由渲染器提供；
// 但折行 / 居中 / 右对齐 / 画布宽度必须按**真实字体度量**算，而边缘运行时读不到字体文件，
// 所以在这里离线提取一次，生成可直接 import 的常量表（改动字体后重跑本脚本）。
//
// 用法：
//   node scripts/gen-font-metrics.mjs <Mojangles.ttf> <unifont-subset.otf> [输出文件]
// 默认输出 src/commands/libs/mcfont.ts。不传参数时给出用法。
//
// 只读 head/hhea/hmtx/cmap/maxp/name 六张表，解析逻辑与 mc-server-cards 项目的 ttf.mjs 一致。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG = (buf, off) => String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);

/** 极简 TTF/OTF 解析：只取排版需要的字段 */
function parseFont(file) {
  const buf = readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    tables[TAG(buf, o)] = { offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) };
  }
  for (const need of ["head", "hhea", "hmtx", "cmap", "maxp"]) {
    if (!tables[need]) throw new Error(file + " 缺少 " + need + " 表");
  }
  const unitsPerEm = dv.getUint16(tables.head.offset + 18);
  const ascender = dv.getInt16(tables.hhea.offset + 4);
  const descender = dv.getInt16(tables.hhea.offset + 6);
  const numberOfHMetrics = dv.getUint16(tables.hhea.offset + 34);
  const numGlyphs = dv.getUint16(tables.maxp.offset + 4);

  // cmap：挑一个覆盖最广的子表（format 4 / 12）
  const cmapOff = tables.cmap.offset;
  let best = null;
  for (let i = 0; i < dv.getUint16(cmapOff + 2); i++) {
    const rec = cmapOff + 4 + i * 8;
    const platform = dv.getUint16(rec), encoding = dv.getUint16(rec + 2);
    const sub = cmapOff + dv.getUint32(rec + 4);
    const format = dv.getUint16(sub);
    if (format !== 4 && format !== 12) continue;
    const score = (format === 12 ? 30 : 20) + (platform === 3 && encoding === 10 ? 5 : platform === 3 && encoding === 1 ? 4 : platform === 0 ? 3 : 0);
    if (!best || score > best.score) best = { score, sub, format };
  }
  if (!best) throw new Error(file + " 找不到可用的 cmap 子表");

  const gidCache = new Map();
  function glyphId(cp) {
    if (gidCache.has(cp)) return gidCache.get(cp);
    let gid = 0;
    if (best.format === 4) {
      const segX2 = dv.getUint16(best.sub + 6);
      const seg = segX2 / 2;
      const endO = best.sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
      for (let i = 0; i < seg; i++) {
        if (dv.getUint16(endO + i * 2) >= cp) {
          const start = dv.getUint16(startO + i * 2);
          if (start > cp) break;
          const delta = dv.getInt16(deltaO + i * 2);
          const range = dv.getUint16(rangeO + i * 2);
          if (range === 0) gid = (cp + delta) & 0xffff;
          else { const g = dv.getUint16(rangeO + i * 2 + range + (cp - start) * 2); gid = g === 0 ? 0 : (g + delta) & 0xffff; }
          break;
        }
      }
    } else {
      let lo = 0, hi = dv.getUint32(best.sub + 12) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const o = best.sub + 16 + mid * 12;
        const s = dv.getUint32(o), e = dv.getUint32(o + 4);
        if (cp < s) hi = mid - 1;
        else if (cp > e) lo = mid + 1;
        else { gid = dv.getUint32(o + 8) + (cp - s); break; }
      }
    }
    gidCache.set(cp, gid);
    return gid;
  }
  function advanceUnits(cp) {
    const gid = glyphId(cp);
    if (gid === 0 || gid >= numGlyphs) return 0;
    return dv.getUint16(tables.hmtx.offset + Math.min(gid, numberOfHMetrics - 1) * 4);
  }
  let family = null;
  if (tables.name) {
    const o = tables.name.offset;
    const count = dv.getUint16(o + 2), strOff = o + dv.getUint16(o + 4);
    for (let i = 0; i < count; i++) {
      const rec = o + 6 + i * 12;
      const platform = dv.getUint16(rec), nameId = dv.getUint16(rec + 6);
      const len = dv.getUint16(rec + 8), off = dv.getUint16(rec + 10);
      if (nameId !== 1) continue;
      const start = strOff + off;
      let s = "";
      if (platform === 3 || platform === 0) { for (let j = 0; j < len; j += 2) s += String.fromCharCode(dv.getUint16(start + j)); }
      else { for (let j = 0; j < len; j++) s += String.fromCharCode(buf[start + j]); }
      family = s;
      if (platform === 3) break;
    }
  }
  return { unitsPerEm, ascender, descender, numGlyphs, family, hasGlyph: (cp) => glyphId(cp) !== 0, advanceUnits };
}

/** 扫描全部 Unicode 码位，按「码位连续 + 推进宽度相同」合并成区间 */
function scanRuns(font) {
  const runs = [];
  let cur = null;
  for (let cp = 0; cp <= 0x10FFFF; cp++) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue; // 代理区不参与 cmap
    if (!font.hasGlyph(cp)) continue;
    const adv = font.advanceUnits(cp);
    if (cur && cur.end === cp - 1 && cur.adv === adv) { cur.end = cp; continue; }
    cur = { start: cp, end: cp, adv };
    runs.push(cur);
  }
  return runs;
}

/** 区间串：码位与推进宽度都写 16 进制；同一宽度归到一个桶里（值 = 桶键），便于人读 */
function toTable(runs) {
  const buckets = new Map();
  for (const r of runs) {
    if (!buckets.has(r.adv)) buckets.set(r.adv, []);
    buckets.get(r.adv).push(r);
  }
  const out = {};
  for (const adv of [...buckets.keys()].sort((a, b) => a - b)) {
    out[adv] = buckets.get(adv)
      .map((r) => r.start.toString(16) + (r.end > r.start ? "-" + r.end.toString(16) : ""))
      .join(",");
  }
  return out;
}

/** 把桶表写成 TS 字面量（每桶一行，长串按 100 字符折行拼接） */
function tableLiteral(table, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [adv, str] of Object.entries(table)) {
    const chunks = str.match(/.{1,100}(?:,|$)/g) || [str];
    if (chunks.length === 1) lines.push(pad + adv + ": '" + str + "',");
    else lines.push(pad + adv + ":\n" + chunks.map((c) => pad + "  '" + c + "'").join(" +\n") + ",");
  }
  return lines.join("\n");
}

const [mojPath, uniPath, outArg] = process.argv.slice(2);
if (!mojPath || !uniPath) {
  console.error("用法：node scripts/gen-font-metrics.mjs <Mojangles.ttf> <unifont-subset.otf> [输出文件]");
  process.exit(1);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(outArg || join(ROOT, "src", "commands", "libs", "mcfont.ts"));

const moj = parseFont(mojPath);
const uni = parseFont(uniPath);
const mojRuns = scanRuns(moj);
const uniRuns = scanRuns(uni);
console.log("Mojangles: " + moj.family + "  unitsPerEm=" + moj.unitsPerEm + "  区间=" + mojRuns.length);
console.log("Unifont:   " + uni.family + "  unitsPerEm=" + uni.unitsPerEm + "  区间=" + uniRuns.length);

const src = `// 字体度量表（**本文件由脚本生成，勿手改**）：见 scripts/gen-font-metrics.mjs。
//
// 为什么需要它：SVG 里只写字体名（不内嵌字形、也不引用字体文件），字形由渲染器
// （api.jsumc.fun 的 /svg 接口 + fontKey）提供；但折行、居中、右对齐、画布宽度
// 都要按**真实字体度量**算，边缘运行时读不到字体文件，于是把度量烘焙在这里。
//
// 字体回退与浏览器一致：Mojangles 有字形就用它，否则用 Unifont（缺字由渲染器跨字体补）。
// 两套字体的度量单位不同：Mojangles 1000 units/em，Unifont 64 units/em。
//
// 数据来源（重跑脚本可再生成）：
//   Mojangles.ttf       ${moj.family}      unitsPerEm=${moj.unitsPerEm}  字形=${moj.numGlyphs}
//   unifont-subset.otf  ${uni.family}      unitsPerEm=${uni.unitsPerEm}  字形=${uni.numGlyphs}

export interface FontMetrics {
  /** 字体家族名：写进 SVG 的 font-family，渲染器按此名匹配 fontKey 里的字体 */
  family: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
}

export const MOJANGLES: FontMetrics = {
  family: '${moj.family}',
  unitsPerEm: ${moj.unitsPerEm},
  ascender: ${moj.ascender},
  descender: ${moj.descender},
};

export const UNIFONT: FontMetrics = {
  family: '${uni.family}',
  unitsPerEm: ${uni.unitsPerEm},
  ascender: ${uni.ascender},
  descender: ${uni.descender},
};

/**
 * 码位覆盖与推进宽度，按推进宽度分桶。
 * 格式：桶键 = 推进宽度（占 unitsPerEm 的分数，16 进制），桶值 = 码位区间串——
 *   "<起>" 或 "<起>-<止>"（闭区间，16 进制），多个区间用 "," 分隔。
 * 不在表里的码位 = 该字体没有这个字形。
 */
const MOJANGLES_RANGES: Record<number, string> = {
${tableLiteral(toTable(mojRuns), 2)}
};

const UNIFONT_RANGES: Record<number, string> = {
${tableLiteral(toTable(uniRuns), 2)}
};

interface Range {
  start: number;
  end: number;
  adv: number;
}

/** 区间串 -> 按起点升序的区间数组（只在模块初始化时跑一次） */
function parseRanges(table: Record<number, string>): Range[] {
  const out: Range[] = [];
  for (const key of Object.keys(table)) {
    const adv = Number(key);
    for (const seg of table[adv].split(',')) {
      const m = /^([0-9a-f]+)(?:-([0-9a-f]+))?$/.exec(seg.trim());
      if (!m) continue;
      out.push({ start: parseInt(m[1], 16), end: parseInt(m[2] || m[1], 16), adv });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const MOJ = parseRanges(MOJANGLES_RANGES);
const UNI = parseRanges(UNIFONT_RANGES);

/** 二分查找：返回命中的区间（无则 null） */
function findRange(ranges: Range[], cp: number): Range | null {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (cp < r.start) hi = mid - 1;
    else if (cp > r.end) lo = mid + 1;
    else return r;
  }
  return null;
}

/** Mojangles 是否有该码位的字形（决定用哪个字体家族、以及字号是否要按拉丁放大） */
export function hasMojanglesGlyph(cp: number): boolean {
  return findRange(MOJ, cp) !== null;
}

/** Mojangles 的推进宽度（单位 1/em），无字形返回 0 */
export function mojanglesAdvance(cp: number): number {
  const r = findRange(MOJ, cp);
  return r ? r.adv / MOJANGLES.unitsPerEm : 0;
}

/** Unifont 的推进宽度（单位 1/em），无字形返回 0 */
export function unifontAdvance(cp: number): number {
  const r = findRange(UNI, cp);
  return r ? r.adv / UNIFONT.unitsPerEm : 0;
}
`;

writeFileSync(OUT, src, "utf8");
console.log("写出 " + OUT + "  " + Math.round(Buffer.byteLength(src, "utf8") / 1024) + " KB");
