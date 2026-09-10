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
  /** webhook 签名/验签用密钥（WEBHOOK_SECRET，缺省回退 APP_SECRET） */
  webhookSecret: string;
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

/** 富媒体文件类型：1 图片 2 视频 3 语音 4 文件 */
export type MediaType = 1 | 2 | 3 | 4;

/** 用户消息携带的富媒体附件（字段名做容错归一化，raw 保留原始对象） */
export interface MessageAttachment {
  /** image / video / audio / file（以平台实际为准） */
  contentType: string;
  filename?: string;
  url?: string;
  raw: unknown;
}

// 场景回复：reply 文本、replyMarkdown（msg_type=2）、replyMedia（先上传后 msg_type=7），均为被动回复

export interface CommandContext {
  name: string;
  /** 命中的子命令链（多级以空格连接，如 'room create'；未命中时为 null） */
  sub: string | null;
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
  /** 用户消息携带的富媒体附件（无则空数组） */
  attachments: MessageAttachment[];
  cfg: Config;
  qq: QqApi;
  /** 文本被动回复（群聊开头自动加换行与 @ 上下文分隔） */
  reply: (content: string) => Promise<void>;
  /** Markdown（msg_type=2）被动回复 */
  replyMarkdown: (content: string) => Promise<void>;
  /** 富媒体（msg_type=7）被动回复：先上传 url 拿 file_info 再发送 */
  replyMedia: (fileType: MediaType, url: string) => Promise<void>;
  deny: () => Promise<void>;
}

/** 子命令：/主命令 <子命令> [args]，支持多级嵌套。可单独设置权限，未设置时继承父级生效等级 */
export interface SubCommand {
  name: string;
  aliases?: string[];
  description: string;
  /** 生效权限等级；未设置时继承父级生效等级 */
  minLevel?: number;
  /** 省略时该节点为分组节点：进入时自动回复子命令用法 */
  handler?: (ctx: CommandContext) => Promise<void>;
  /** 更深一级的子命令 */
  subcommands?: SubCommand[];
}

export interface Command {
  name: string;
  aliases: string[];
  description: string;
  scenes: Scene[];
  minLevel: number;
  /** 子命令（可选），支持多级嵌套：如 /game room create */
  subcommands?: SubCommand[];
  /** 省略时自动回复子命令用法（需要声明 subcommands） */
  handler?: (ctx: CommandContext) => Promise<void>;
}

export interface QqApi {
  getAccessToken: (cfg: Config) => Promise<string>;
  sendGroupMessage: (cfg: Config, groupOpenid: string, content: string, msgId?: string) => Promise<any>;
  sendC2CMessage: (cfg: Config, userOpenid: string, content: string, msgId?: string) => Promise<any>;
  /** 发送 Markdown（msg_type=2）；scene 决定群/私聊端点 */
  sendMarkdown: (cfg: Config, scene: Scene, openid: string, markdown: string, msgId?: string) => Promise<any>;
  /** URL 上传富媒体，返回 file_info（srv_send_msg=false，不占主动消息额度） */
  uploadFile: (cfg: Config, scene: Scene, openid: string, fileType: MediaType, url: string) => Promise<string>;
  /** 发送富媒体（msg_type=7），fileInfo 来自 uploadFile；scene 决定群/私聊端点 */
  sendMedia: (cfg: Config, scene: Scene, openid: string, fileInfo: string, msgId?: string) => Promise<any>;
  /** 原样发送消息体（msg_id/msg_seq 由调用方组装，供订阅通知等主动发送场景） */
  sendBody: (cfg: Config, scene: Scene, openid: string, body: Record<string, unknown>) => Promise<any>;
  getGroupMember: (cfg: Config, groupOpenid: string, memberOpenid: string) => Promise<MemberInfo | null>;
  listGroupMembers: (cfg: Config, groupOpenid: string, limit?: number, after?: string) => Promise<any>;
}

export interface EdgeContext {
  request: Request;
  env?: Record<string, string | undefined>;
  waitUntil?: (p: Promise<unknown>) => void;
}
