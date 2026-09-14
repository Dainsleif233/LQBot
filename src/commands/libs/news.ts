// 新闻推送：外部新闻源（SWUSTMC NEWS，如 mc-news 插件的 mc.news.new 事件）经 POST /news
// webhook 推来，这里统一做「鉴权 → 向已订阅场景推送 Markdown」。
//
// 存储（KV news 命名空间，全部走全局作用域）：
//   - news:global:subs   订阅者索引 [{scene, openid}]（/news 命令开关，状态只看索引）
//
// 推送走**主动消息**（无 msg_id，不占被动回复窗口），受 QQ 每月主动消息额度限制（群/单聊各 4 条），
// 单条失败只计数并打日志，不抛出——避免一篇新闻把整批推送带崩。
import type { Config, Scene } from '../../libs/types.js';
import * as qq from '../../libs/qq.js';

/** 新闻数据命名空间（key 形如 news:global:subs） */
export const NEWS_NS = 'news';
const SUBS_KEY = 'subs';

export interface NewsSubscriber {
  scene: Scene;
  openid: string;
}

/** 推送载荷（以 mc-news 插件为准，字段缺失一律容错） */
export interface NewsItem {
  event?: string;
  title?: string;
  url?: string;
  content?: string;
  summary?: string;
  sourceName?: string;
  publishedAt?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface PushResult {
  /** 订阅场景总数 */
  total: number;
  ok: number;
  fail: number;
}

/**
 * 校验请求头 x-secret 与环境变量 SWUSTMC_NEWS 是否一致。
 * expected 为空视为「未配置」，一律不通过（fail-closed，不能默认放行）。
 */
export function isSecretValid(expected: string, provided: string | null | undefined): boolean {
  if (!expected) return false;
  const got = String(provided ?? '');
  if (got.length !== expected.length) return false;
  // 长度已比过，逐字符异或累计后统一判断，避免提前 return 泄露前缀匹配长度
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/** 读取订阅者索引；KV 未绑定/数据损坏时返回空数组 */
export async function loadSubscribers(cfg: Config): Promise<NewsSubscriber[]> {
  const raw = await cfg.storage.ns(NEWS_NS).global.getJSON<NewsSubscriber[]>(SUBS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => !!s && (s.scene === 'group' || s.scene === 'private') && typeof s.openid === 'string' && !!s.openid);
}

export async function saveSubscribers(cfg: Config, list: NewsSubscriber[]): Promise<void> {
  await cfg.storage.ns(NEWS_NS).global.setJSON(SUBS_KEY, list);
}

/** 开关某个场景（群聊/私聊）的订阅，返回开关后的状态：true = 现在已订阅 */
export async function toggleSubscription(cfg: Config, scene: Scene, openid: string): Promise<boolean> {
  const subs = await loadSubscribers(cfg);
  const on = subs.some((s) => s.scene === scene && s.openid === openid);
  const next = on
    ? subs.filter((s) => !(s.scene === scene && s.openid === openid))
    : [...subs, { scene, openid }];
  await saveSubscribers(cfg, next);
  return !on;
}

/** 推送正文：优先用源给的 content（本身已是 Markdown）；缺失时用标题/摘要/原文链接兜底拼一份 */
export function buildMarkdown(item: NewsItem): string {
  const content = typeof item?.content === 'string' ? item.content.trim() : '';
  if (content) return content;
  const title = String(item?.title ?? '').trim();
  const summary = String(item?.summary ?? '').trim();
  const url = String(item?.url ?? '').trim();
  const lines: string[] = ['# ' + (title || '新闻推送')];
  if (summary) lines.push('', summary);
  if (url) lines.push('', '[🔗 点击查看原文](' + url + ')');
  return lines.join('\n');
}

/** 向所有订阅场景推送同一份 Markdown（主动消息，无 msg_id）；单条失败只计数不抛出 */
export async function pushToSubscribers(cfg: Config, markdown: string): Promise<PushResult> {
  const subs = await loadSubscribers(cfg);
  const result: PushResult = { total: subs.length, ok: 0, fail: 0 };
  for (const sub of subs) {
    try {
      await qq.sendMarkdown(cfg, sub.scene, sub.openid, markdown);
      result.ok++;
    } catch (e) {
      result.fail++;
      console.error('[news] 推送失败 scene=' + sub.scene + ' openid=' + sub.openid + '：' + (e instanceof Error ? e.message : e));
    }
  }
  return result;
}
