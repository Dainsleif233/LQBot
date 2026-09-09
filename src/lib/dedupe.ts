// 消息去重：QQ 可能重复投递同一条消息（相同 msg_id），这里登记最近处理过的消息 id，
// 窗口期内再次出现即视为重复，调用方跳过处理，避免重复回复 / 重复执行命令。
//
// 存储策略（相比"一条消息一个永久 key"的优化）：
//   - 全部汇总到单个 key `bot:seen`（全局命名空间），key 数量恒定、不会随时间无限增长；
//   - 每次写入顺手裁剪窗口外的旧条目，并限制最大条目数，value 有界；
//   - 每处理一条消息仍是 1 次读 + 1 次写，与原来持平；重复消息只读不写。
// KV 不可用 / 数据损坏 / 读写异常时一律返回 false（宁可不做去重，也不阻塞正常处理）。
import type { Config } from './types.js';

/** 去重窗口（毫秒）：窗口内重复的同一 msg_id 视为重复投递 */
export const DEDUPE_WINDOW_MS = 600_000; // 10 分钟
/** 单 key 内最多保留的条目数，防止高频场景下 value 无界增长 */
export const DEDUPE_MAX_ENTRIES = 500;
/** 全局命名空间下的 key 名（实际存储为 `bot:seen`） */
const SEEN_KEY = 'seen';

type SeenMap = Record<string, number>;

/**
 * 判断并登记一条消息。
 * @returns true = 窗口内已见过（调用方应跳过处理）；false = 首次见到并已登记。
 */
export async function isDuplicate(cfg: Config, messageId: string): Promise<boolean> {
  if (!messageId) return false;
  const store = cfg.storage.global;
  if (!store.available) return false;

  const now = Date.now();
  let seen: SeenMap = {};
  try {
    const loaded = await store.getJSON<SeenMap>(SEEN_KEY);
    if (loaded && typeof loaded === 'object') seen = loaded;
  } catch (_) {
    seen = {};
  }

  // 裁剪窗口外的旧条目
  const kept: SeenMap = {};
  for (const id of Object.keys(seen)) {
    const ts = seen[id];
    if (typeof ts === 'number' && now - ts < DEDUPE_WINDOW_MS) kept[id] = ts;
  }

  // 命中：窗口内已处理过，直接判重（无需写回）
  if (kept[messageId] !== undefined) return true;

  kept[messageId] = now;

  // 限制条目数：超出则丢弃最旧的
  const ids = Object.keys(kept);
  if (ids.length > DEDUPE_MAX_ENTRIES) {
    ids.sort((a, b) => kept[a] - kept[b]);
    for (const id of ids.slice(0, ids.length - DEDUPE_MAX_ENTRIES)) delete kept[id];
  }

  try {
    await store.setJSON(SEEN_KEY, kept);
  } catch (_) { /* 写入失败不影响本次处理 */ }
  return false;
}
