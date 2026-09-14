// 字体度量表（**本文件由脚本生成，勿手改**）：见 scripts/gen-font-metrics.mjs。
//
// 为什么需要它：SVG 里只写字体名（不内嵌字形、也不引用字体文件），字形由渲染器
// （api.jsumc.fun 的 /svg 接口 + fontKey）提供；但折行、居中、右对齐、画布宽度
// 都要按**真实字体度量**算，边缘运行时读不到字体文件，于是把度量烘焙在这里。
//
// 字体回退与浏览器一致：Mojangles 有字形就用它，否则用 Unifont（缺字由渲染器跨字体补）。
// 两套字体的度量单位不同：Mojangles 1000 units/em，Unifont 64 units/em。
//
// 数据来源（重跑脚本可再生成）：
//   Mojangles.ttf       Minecraft Seven      unitsPerEm=1000  字形=662
//   unifont-subset.otf  Unifont      unitsPerEm=64  字形=25963

export interface FontMetrics {
  /** 字体家族名：写进 SVG 的 font-family，渲染器按此名匹配 fontKey 里的字体 */
  family: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
}

export const MOJANGLES: FontMetrics = {
  family: 'Minecraft Seven',
  unitsPerEm: 1000,
  ascender: 1000,
  descender: -100,
};

export const UNIFONT: FontMetrics = {
  family: 'Unifont',
  unitsPerEm: 64,
  ascender: 56,
  descender: -8,
};

/**
 * 码位覆盖与推进宽度，按推进宽度分桶。
 * 格式：桶键 = 推进宽度（占 unitsPerEm 的分数，16 进制），桶值 = 码位区间串——
 *   "<起>" 或 "<起>-<止>"（闭区间，16 进制），多个区间用 "," 分隔。
 * 不在表里的码位 = 该字体没有这个字形。
 */
const MOJANGLES_RANGES: Record<number, string> = {
  0: '0',
  200: '21,27,2c,2e,3a-3b,69,7c,a1,a6,b7,ec-ef,129,12b,12d,12f,131,2d9,456-457',
  300: 'd,20,60,6c,b4,b8,13a,13c,2db,384,390,3af,3b9,3ca,2018-201a,2022,f6c3',
  400:
    '22,2a,2d,49,5b,5d,74,a8,aa,ad,af,ba,cc-cf,128,12a,12c,12e,130,13e,140,142,163,167,21b,2c6-2c7,2c9,' +
    '399,3aa,406-407,1e6b,2020-2021,2039-203a',
  500:
    '28-29,3c,3e,66,6b,7b,7d,a0,b0,df,133,137-138,165,2d8,2da,2dc,385,3b2,3ba,43a,45c,1e1f,1e31,201c-201e,' +
    '20ac',
  550: '433,453,491',
  600:
    '23-26,2b,2f-39,3d,3f,41-48,4a-5a,5c,5e-5f,61-65,67-68,6a,6d-73,75-7a,a2-a3,a5,a7,ac,b1,b6,bf-c5,' +
    'c7-cb,d1-de,e0-e5,e7-eb,f0-10e,112-125,134-136,139,13b,13d,13f,141,143-148,14a-151,154-162,164,166,' +
    '168-17e,192,1fe-1ff,218-21a,237,2dd,38a,391-398,39a-3a1,3a3-3a9,3ab-3ae,3b0-3b1,3b3-3b8,3bb-3c9,' +
    '3cb-3ce,400-401,403-405,408,40c-413,415,417-428,42c-42d,42f-432,435,437-439,43b-448,44c-44d,44f-451,' +
    '454-455,458,45d-45f,490,1e02-1e03,1e0a-1e0b,1e1e,1e22-1e23,1e30,1e40-1e41,1e56-1e57,1e60-1e61,1e6a,' +
    '1e80-1e85,1e9e,1ef2-1ef3,2013,2026,2044,2126,2206,220f,2211-2212,25ca',
  650: 'd0,110-111,127,429,434,449,452,45b',
  700: '40,7e,ab,bb,402,40b,414,42a-42b,42e,44a-44b,44e,fb01',
  800: 'a9,ae,c6,e6,10f,126,152-153,1fc-1fd,386,388-389,38c,38e-38f,40a,416,436,45a,2014,2030,221e,fb02',
  900: '132,409,459',
  1000: '2015,2122',
};

const UNIFONT_RANGES: Record<number, string> = {
  0: '300-34e,350-36f,483-489,302a-302f,3099-309a',
  32:
    '20-7e,a0-ac,ae-24f,2b0-2ff,370-377,37a-37f,384-38a,38c,38e-3a1,3a3-482,48a-4ff,1e00-1eff,2000-200a,' +
    '2010-2027,202f-2056,2058-205f,2070-2071,2074-208e,2090-209c,20a0-20b8,20ba-20c1,2100-2109,210c-210f,' +
    '2111,2113-211a,211c-212b,212d-212f,2132,2135-2139,213e,2141-2144,214a-214b,214d-214e,2150-2181,' +
    '2183-2187,2189-218b,2190-219b,219e-21f3,21f5-21f8,21fd-21fe,2200-22b5,22b9-22d7,22da-22f1,22f4,' +
    '22f7-22f8,22fc,22fe,2300-2315,2317-232b,2336-237a,237f-2380,2395-2396,239b-23b1,23b7-23bf,23cb-23cc,' +
    '23cf-23d3,23da,23e8,2500-25ee,25f0-2602,2604,2607-2614,261a-2621,2625-262a,262d-262e,2638-2671,' +
    '2690-2691,26a1,26a8,26aa-26ac,26b2-26b5,26b7-26bc,26e2,2713,2717,2768-2775,27b0,299b,29a0,29a3,29f5,' +
    '2ade,2aee,2b06-2b07,2b0d,2b1d-2b1e,2b25-2b2b,2b2e-2b2f,2b31,2b4e-2b4f,2bc9,2bff,303f,ff61-ffbe,' +
    'ffc2-ffc7,ffca-ffcf,ffd2-ffd7,ffda-ffdc,ffe8-ffee',
  64:
    'ad,34f,378-379,380-383,38b,38d,3a2,200b-200f,2028-202e,2057,2060-206f,2072-2073,208f,209d-209f,20b9,' +
    '20c2-20cf,210a-210b,2110,2112,211b,212c,2130-2131,2133-2134,213a-213d,213f-2140,2145-2149,214c,214f,' +
    '2182,2188,218c-218f,219c-219d,21f4,21f9-21fc,21ff,22b6-22b8,22d8-22d9,22f2-22f3,22f5-22f6,22f9-22fb,' +
    '22fd,22ff,2316,232c-2335,237b-237e,2381-2394,2397-239a,23b2-23b6,23c0-23ca,23cd-23ce,23d4-23d9,' +
    '23db-23e7,23e9-23ff,2460-24ff,25ef,2603,2605-2606,2615-2619,2622-2624,262b-262c,262f-2637,2672-268f,' +
    '2692-26a0,26a2-26a7,26a9,26ad-26b1,26b6,26bd-26e1,26e3-2712,2714-2716,2718-2767,2776-27af,27b1-27bf,' +
    '27dc,29b8,2ae3-2ae5,2b00-2b05,2b08-2b0c,2b0e-2b1c,2b1f-2b24,2b2c-2b2d,2b30,2b32-2b4d,2b50-2bc8,' +
    '2bca-2bfe,2e80-2fdf,3000-3029,3030-303e,3040-3098,309b-312f,3200-33ff,4e00-9fff,fe10-fe1f,fe30-fe6f,' +
    'ff00-ff60,ffbf-ffc1,ffc8-ffc9,ffd0-ffd1,ffd8-ffd9,ffdd-ffe7,ffef',
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
