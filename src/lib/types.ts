export type Scene = 'group' | 'private';
export interface KVLike {
  get(key: string, type?: string): Promise<any>;
  put(key: string, value: string): Promise<void>;
}
export interface Config {
  appId: string;
  appSecret: string;
  apiBase: string;
  superAdminOpenid: string;
  verifyEventSignature: boolean;
  checkGroupAdmin: boolean;
  groupSceneLevel: number;
  kv: KVLike | null;
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