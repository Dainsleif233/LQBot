export type Scene = 'group' | 'private';

/** EdgeOne KV 绑定（绑定变量名 LQBOT）暴露的最小接口 */
export interface KVLike {
  get(key: string, type?: string): Promise<any>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 命名空间化的存取器：所有 key 自动加 `<namespace>:` 前缀 */
export interface Store {
  /** 命名空间名（即 key 前缀，不含冒号） */
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

/** 持久化入口：global 用于跨模块基础设施，ns(name) 用于各命令/模块自己的数据 */
export interface Storage {
  readonly available: boolean;
  /** 全局命名空间（前缀 bot:） */
  readonly global: Store;
  /** 取某命名空间的存取器（模块级数据） */
  ns(name: string): Store;
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
