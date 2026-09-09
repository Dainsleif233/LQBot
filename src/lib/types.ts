export type Scene = 'group' | 'private';

/** EdgeOne KV 绑定（绑定变量名 LQBOT）暴露的最小接口 */
export interface KVLike {
  get(key: string, type?: string): Promise<any>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 单个作用域下的存取器：所有 key 自动加前缀 */
export interface Store {
  /** 所属命名空间名（用于调试/日志） */
  readonly namespace: string;
  /** KV 是否已绑定；未绑定时 get 恒返回 null、写/删静默跳过 */
  readonly available: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown): Promise<void>;
}

/** 场景作用域：群聊按 group_openid、私聊按 user_openid 隔离 */
export interface StorageScope {
  scene: Scene;
  groupOpenid?: string | null;
  userOpenid?: string | null;
}

/** 一个命名空间内的两级存储：全局变量 + 场景变量 */
export interface NamespaceStore {
  readonly name: string;
  readonly available: boolean;
  /** 全局变量：整个机器人共享同一份值，key 形如 `<ns>:global:<key>` */
  readonly global: Store;
  /** 群聊场景变量，key 形如 `<ns>:group:<group_openid>:<key>`；openid 为空返回 null */
  group(groupOpenid?: string | null): Store | null;
  /** 用户场景变量，key 形如 `<ns>:user:<user_openid>:<key>`；openid 为空返回 null */
  user(userOpenid?: string | null): Store | null;
  /** 按当前场景自动选 group/user（可直接传 CommandContext） */
  scene(scope: StorageScope): Store | null;
}

/** 持久化入口 */
export interface Storage {
  readonly available: boolean;
  /** 基础设施命名空间（前缀 bot:）：token 缓存、消息去重等跨模块数据 */
  readonly infra: NamespaceStore;
  /** 模块命名空间（前缀 <name>:）：各命令自己的业务数据 */
  ns(name: string): NamespaceStore;
}

export interface Config {
  appId: string;
  appSecret: string;
  apiBase: string;
  superAdminOpenid: string;
  verifyEventSignature: boolean;
  checkGroupAdmin: boolean;
  groupSceneLevel: number;
  storage: Storage;
}

export interface MemberInfo {
  user_openid?: string;
  member_openid?: string;
  nick?: string;
  role?: unknown;
  [key: string]: unknown;
}

export interface CommandContext {
  name: string;
  args: string[];
  raw: string;
  original: string;
  scene: Scene;
  userOpenid: string | null;
  memberOpenid: string | null;
  groupOpenid: string | null;
  nick: string | null;
  level: number;
  memberInfo: MemberInfo | null;
  event: any;
  messageId: string;
  cfg: Config;
  qq: QqApi;
  reply: (content: string) => Promise<void>;
  deny: () => Promise<void>;
}

export interface Command {
  name: string;
  aliases: string[];
  description: string;
  scenes: Scene[];
  minLevel: number;
  handler: (ctx: CommandContext) => Promise<void>;
}

export interface QqApi {
  getAccessToken: (cfg: Config) => Promise<string>;
  sendGroupMessage: (cfg: Config, groupOpenid: string, content: string, eventId?: string) => Promise<any>;
  sendC2CMessage: (cfg: Config, userOpenid: string, content: string, eventId?: string) => Promise<any>;
  getGroupMember: (cfg: Config, groupOpenid: string, memberOpenid: string) => Promise<MemberInfo | null>;
  listGroupMembers: (cfg: Config, groupOpenid: string, limit?: number, after?: string) => Promise<any>;
}

export interface EdgeContext {
  request: Request;
  env?: Record<string, string | undefined>;
  waitUntil?: (p: Promise<unknown>) => void;
}
