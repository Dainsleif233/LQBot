// 统一的 KV 持久化封装：按命名空间隔离 key，并屏蔽「KV 未绑定」的空值分支。
//
// 命名空间 = key 前缀，实际存储的 key 形如 `<namespace>:<key>`：
//   - storage.global   -> 前缀 `bot:`，跨模块的基础设施数据（token 缓存、消息去重标记等）
//   - storage.ns(name) -> 前缀 `<name>:`，各命令/模块自己的业务数据（如权限覆盖 perm:<openid>）
//
// 约定（命令处理器持久化规范）：
//   1. handler 只用 ctx.cfg.storage，不直接碰全局 KV 变量；
//   2. 业务 key 一律走自己模块的命名空间，避免与其他模块冲突；
//   3. KV 未绑定时 storage.available 为 false：读恒返回 null、写/删静默跳过；
//      需要给用户反馈的地方先判 available 再提示「KV 未绑定」。
import type { KVLike, Storage, Store } from './types.js';

/** 全局/基础设施命名空间前缀 */
export const GLOBAL_NS = 'bot';

/** 用原始 KV 绑定构造命名空间化的 Storage；kv 为 null 时得到"不可用"的只读空实现。 */
export function createStorage(kv: KVLike | null): Storage {
  function makeStore(ns: string): Store {
    const prefix = ns + ':';
    const full = (key: string): string => prefix + key;
    const get = async (key: string): Promise<string | null> => {
      if (!kv) return null;
      try {
        const raw = await kv.get(full(key));
        return raw === null || raw === undefined ? null : String(raw);
      } catch (_) {
        return null;
      }
    };
    const set = async (key: string, value: string): Promise<void> => {
      if (!kv) return;
      await kv.put(full(key), value);
    };
    const del = async (key: string): Promise<void> => {
      if (!kv) return;
      await kv.delete(full(key));
    };
    const has = async (key: string): Promise<boolean> => (await get(key)) !== null;
    const getJSON = async <T>(key: string): Promise<T | null> => {
      const raw = await get(key);
      if (raw === null) return null;
      try { return JSON.parse(raw) as T; } catch (_) { return null; }
    };
    const setJSON = async (key: string, value: unknown): Promise<void> => set(key, JSON.stringify(value));
    return { namespace: ns, available: !!kv, get, set, del, has, getJSON, setJSON };
  }
  return { available: !!kv, ns: makeStore, global: makeStore(GLOBAL_NS) };
}
