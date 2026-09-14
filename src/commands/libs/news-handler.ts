// 新闻推送主逻辑：POST /news 的鉴权 / 解析 / 推送 / 响应。
// 边缘函数入口 edge-functions/news.ts 只做转发（与 handler.ts ← webhook.ts 同一分工）。
//
// 处理链路：校验 x-secret（== 环境变量 SWUSTMC_NEWS，fail-closed）
// → 向 /news 命令订阅过的群/私聊推送 Markdown（正文取载荷的 content 字段）。
//
// 载荷形态以 mc-news 插件（YuDream-McNews）为准，单篇对象或一次多篇的数组都支持：
//   { "event":"mc.news.new", "title":"…", "url":"…", "content":"## …(Markdown)", "sourceName":"…", … }
//
// 日志：本模块不打任何日志（正常与异常都静默），失败只体现为 HTTP 状态码与响应体的 error 字段。
//
// ⚠️ 本模块跑在 EdgeOne Edge Functions（V8 轻量运行时，非 Node.js）：
//    - 不能 new Headers()，只能读平台注入的 request.headers；
//    - 没有 Response.json()，统一用 new Response(JSON.stringify(...), { headers })。
// ⚠️ 推送是同步 await 完再返回的（边缘运行时可能在返回后立刻冻结 isolate，waitUntil 会丢推送）。
import { createConfig } from '../../libs/config.js';
import { buildMarkdown, isSecretValid, pushToSubscribers } from './news.js';
import type { EdgeContext } from '../../libs/types.js';
import type { NewsItem } from './news.js';

const jsonHeaders: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };

/** 统一 JSON 响应（边缘运行时无 Response.json()） */
function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

/** POST /news：鉴权 → 解析 → 推送订阅场景 */
export async function handleNewsPush(context: EdgeContext): Promise<Response> {
  const { request } = context;
  const cfg = createConfig(context.env);

  // 1) 鉴权：x-secret 必须与环境变量 SWUSTMC_NEWS 一致；未配置密钥时拒绝一切推送（fail-closed）
  if (!cfg.newsSecret) {
    return jsonResponse({ ok: false, error: 'news secret not configured' }, 500);
  }
  if (!isSecretValid(cfg.newsSecret, request.headers.get('x-secret'))) {
    return jsonResponse({ ok: false, error: 'invalid x-secret' }, 401);
  }

  // 2) 解析请求体：兼容单篇对象与「一次多篇」数组
  const raw = await request.text();
  if (raw.trim() === '') {
    return jsonResponse({ ok: false, error: 'empty body' }, 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonResponse({ ok: false, error: 'invalid json: ' + message }, 400);
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (!items.length) {
    return jsonResponse({ ok: false, error: 'empty payload' }, 400);
  }

  // 3) 逐篇推送（推送失败只计数，不影响其它篇章，也不让源侧重试整批）
  let invalid = 0;
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      invalid++;
      continue;
    }
    const result = await pushToSubscribers(cfg, buildMarkdown(item as NewsItem));
    sent += result.ok;
    failed += result.fail;
  }

  return jsonResponse({ ok: true, received: items.length, invalid, sent, failed }, 200);
}
