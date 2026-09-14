// api.jsumc.fun 客户端：批量 ping 服务器状态 + 把 SVG 交给官方渲染接口换成一张图片地址。
// 接口文档：https://api.jsumc.fun/api.yml
//
// 渲染接口用法（框架只支持「给 URL 上传富媒体」，所以必须落到一个图片 URL）：
//   1. POST /svg?width=<宽>&fontKey=<字体key>，body 就是 SVG 文本（Content-Type: image/svg+xml）；
//   2. 响应头 X-Cache-Key 即这张图的 cacheKey（64 位 sha256）。**拿到状态码和响应头就够了**，
//      PNG 字节不需要（服务端在发响应头前已经渲染完并写进 Blob 缓存），直接把响应体丢掉，
//      省掉一次下载和内存占用；
//   3. GET /svg?key=<cacheKey> 就是最终交给框架的图片地址（QQ 侧按 URL 拉取上传）。
//
// 字体：SVG 里不内嵌字体，靠 fontKey 让渲染器把字体注册进来（key = 字体文件内容的 sha256）。
// 两个 key 对应 Mojangles（拉丁 / Minecraft Seven）与 unifont-subset（中文，缺字回退）。
import type { MediaType } from '../../lib/types.js';

/** 接口基地址 */
export const JSUMC_API_BASE = 'https://api.jsumc.fun';
/** 渲染用字体（sha256 = fontKey）：Mojangles + 精简 Unifont，逗号分隔 */
export const JSUMC_FONT_KEY =
  'f60dbf1c4281c8bb6c31364391bd0029e2d066474c44b47a542b90cf0b719ee7,' +
  '4c0a6dcebb10dd1b85411ecaddf8638b6b25b16ca95069386d74388f61f1e14e';
/** ping 接口单次上限：超出部分会被截断丢弃，必须分片请求 */
export const PING_BATCH = 20;
/** 富媒体类型：1 = 图片（渲染结果是 PNG，交给 QQ 上传时按图片处理） */
export const JSUMC_IMAGE_TYPE: MediaType = 1;

/** 单台服务器的 ping 结果（失败时只有 server + error） */
export interface PingResult {
  server?: string;
  target?: string;
  latency?: number;
  info?: {
    version?: { protocol?: number; name?: string };
    players?: { online?: number; max?: number; sample?: unknown[] };
    description?: unknown;
    favicon?: string;
  };
  error?: string;
  message?: string;
}

/** 请求超时（运行时没有 AbortSignal.timeout 时退化为不设超时） */
function timeoutSignal(ms: number): AbortSignal | undefined {
  const A = typeof AbortSignal !== 'undefined' ? (AbortSignal as any) : null;
  return A && typeof A.timeout === 'function' ? (A.timeout(ms) as AbortSignal) : undefined;
}

/**
 * 批量查询服务器状态：POST /ping（application/json）。
 * 按 PING_BATCH 分片；返回顺序与入参一致，缺项用「接口未返回」占位，不会因单台失败而整体失败。
 */
export async function pingServers(servers: string[]): Promise<PingResult[]> {
  const out: PingResult[] = [];
  for (let i = 0; i < servers.length; i += PING_BATCH) {
    const chunk = servers.slice(i, i + PING_BATCH);
    const res = await fetch(JSUMC_API_BASE + '/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ servers: chunk }),
      signal: timeoutSignal(15000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error('状态接口 HTTP ' + res.status + '：' + text.slice(0, 160));
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch (_) { throw new Error('状态接口返回的不是 JSON：' + text.slice(0, 160)); }
    const arr: PingResult[] = Array.isArray(data)
      ? (data as PingResult[])
      : (data && Array.isArray((data as any).servers) ? ((data as any).servers as PingResult[]) : []);
    // 按返回的 server 字段对回（缺失时退化为按位置对应，接口是并发处理但保持入参顺序）
    const pool = arr.slice();
    for (const host of chunk) {
      let idx = pool.findIndex((x) => String((x && x.server) || '').toLowerCase() === host.toLowerCase());
      if (idx < 0) idx = 0;
      out.push(pool.length ? (pool.splice(idx, 1)[0] as PingResult) : { server: host, error: '接口未返回该服务器' });
    }
  }
  return out;
}

/**
 * 把 SVG 交给渲染接口，返回可直接交付给框架的 PNG 图片 URL。
 * 只等响应头（状态码 + X-Cache-Key），不等 PNG 响应体。
 */
export async function renderSvgToImageUrl(svg: string, width: number): Promise<string> {
  // 接口 width 默认 800、上限 4096：不显式给就会把图缩小，所以取 SVG 自身宽度。
  const w = Math.max(16, Math.min(4096, Math.round(width)));
  const url = JSUMC_API_BASE + '/svg?width=' + w + '&fontKey=' + JSUMC_FONT_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'image/svg+xml' },
    body: svg,
    signal: timeoutSignal(30000),
  });
  if (!res.ok) {
    // 出错时响应体是小的 JSON 错误说明，读出来给用户/日志看
    const detail = await res.text().catch(() => '');
    throw new Error('渲染接口 HTTP ' + res.status + '：' + detail.slice(0, 160));
  }
  const key = res.headers.get('X-Cache-Key');
  if (!key) throw new Error('渲染接口未返回 X-Cache-Key');
  // 不需要 PNG 字节：丢弃响应体（服务端已把图写进 Blob，GET 立即可取）。
  try {
    const cancelled = res.body ? (res.body.cancel() as unknown as Promise<void>) : null;
    if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => { /* 丢弃即可 */ });
  } catch (_) { /* 运行时若不支持取消，忽略 */ }
  return JSUMC_API_BASE + '/svg?key=' + key;
}
