// 统一的 KV 持久化封装：命名空间（模块隔离）+ 作用域（全局/场景）两级。
//
// key 结构： `<命名空间>:<作用域>:<openid?>:<key>`
//   - 全局变量： <ns>:global:<key>                 整个机器人共享
//   - 群聊场景： <ns>:group:<group_openid>:<key>   同一群共享，不同群互不影响
//   - 用户场景： <ns>:user:<user_openid>:<key>     同一用户共享，不同用户互不影响
//
// 命名空间：
//   - storage.infra      -> 前缀 `bot:`，跨模块基础设施（token 缓存、消息去重）
//   - storage.ns(name)   -> 前缀 `<name>:`，各命令/模块自己的业务数据
//
// 约定（命令处理器持久化规范）：
//   1. 只用 ctx.cfg.storage，不直接碰全局 KV 变量；
//   2. 业务数据走自己模块的命名空间；需要按群/按用户隔离时用场景变量；
//   3. KV 未绑定时 available 为 false：读恒 null、写/删静默跳过；
//      需要给用户反馈时先判 available 再提示「KV 未绑定」。
import type { KVLike, NamespaceStore, Storage, StorageScope, Store } from './types.js';

/** 基础设施命名空间前缀 */
export const INFRA_NS = 'bot';

/** 用原始 KV 绑定构造 Storage；kv 为 null 时得到"不可用"的空实现。 */
export function createStorage(kv: KVLike | null): Storage {
  // 单个作用域的存取器
  function makeStore(namespace: string, prefix: string): Store {
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
    return { namespace, available: !!kv, get, set, del, has, getJSON, setJSON };
  }

  // 一个命名空间：global / group / user / scene
  function makeNamespace(name: string): NamespaceStore {
    const base = name + ':';
    const globalStore = makeStore(name, base + 'global:');
    const group = (groupOpenid?: string | null): Store | null =>
      groupOpenid ? makeStore(name, base + 'group:' + groupOpenid + ':') : null;
    const user = (userOpenid?: string | null): Store | null =>
      userOpenid ? makeStore(name, base + 'user:' + userOpenid + ':') : null;
    const byScene = (scope: StorageScope): Store | null => {
      if (!scope) return null;
      return scope.scene === 'group' ? group(scope.groupOpenid) : user(scope.userOpenid);
    };
    return { name, available: !!kv, global: globalStore, group, user, scene: byScene };
  }

  return { available: !!kv, infra: makeNamespace(INFRA_NS), ns: makeNamespace };
}
