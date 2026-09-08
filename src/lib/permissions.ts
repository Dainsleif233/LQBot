// 权限系统：挡位进阶，3 > 2 > 1 > 0。
// 解析顺序：超级管理员(env,3) > KV 显式覆盖(0-3) > 场景默认值。
import type { Config, Scene, MemberInfo } from './types.js';
export const LEVELS = { SUPER_ADMIN: 3, GLOBAL_ADMIN: 2, GROUP_ADMIN: 1, USER: 0 } as const;
export const LEVEL_NAMES: Record<number, string> = {
  3: '超级管理员',
  2: '全局管理员',
  1: '群聊管理员',
  0: '普通用户',
};
export function levelName(n: number): string {
  return LEVEL_NAMES[n] || ('未知(' + n + ')');
}
// 真实群管身份识别：优先用群消息事件 author.member_role（owner/admin/member），
// handler 已据此构造 memberInfo.role 传入；群成员接口(role 字段)仅作兜底。
// 按常见形态兼容：role 含 admin|owner|管理员|群主 或 数字>=2 判群管。
function isGroupAdminRole(role: unknown): boolean {
  if (role === undefined || role === null) return false;
  if (typeof role === 'string') return /admin|owner|管理员|群主/i.test(role);
  if (typeof role === 'number') return role >= 2; // 假定 1=普通, 2=管理员/群主（需按实际校准）
  return false;
}
interface ResolveOpts {
  scene: Scene;
  userOpenid: string | null;
  groupOpenid: string | null;
  memberOpenid: string | null;
  memberInfo: MemberInfo | null;
}
// 解析某用户在某场景下的有效权限等级。
export async function resolveLevel(cfg: Config, opts: ResolveOpts): Promise<number> {
  const { scene, userOpenid, groupOpenid, memberOpenid, memberInfo } = opts;
  // 1. 超级管理员（环境变量，等级 3）
  if (cfg.superAdminOpenid && userOpenid && userOpenid === cfg.superAdminOpenid) {
    return LEVELS.SUPER_ADMIN;
  }
  // 2. KV 中的显式覆盖（覆盖场景值）
  if (cfg.kv && userOpenid) {
    try {
      const raw = await cfg.kv.get('perm:' + userOpenid);
      if (raw !== null && raw !== undefined && raw !== '') {
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n) && n >= 0 && n <= 3) return n;
      }
    } catch (_) { /* KV 不可用，忽略 */ }
  }
  // 3. 场景默认值
  // 私聊消息权限同群聊管理员(1)。
  if (scene === 'private') return LEVELS.GROUP_ADMIN;
  // 群聊：尝试用真实群管身份识别；失败或关闭时回落到 groupSceneLevel。
  if (cfg.checkGroupAdmin) {
    let member = memberInfo;
    if (!member && groupOpenid && memberOpenid) {
      try {
        const qq = await import('./qq.js');
        member = await qq.getGroupMember(cfg, groupOpenid, memberOpenid);
      } catch (_) { member = null; }
    }
    if (member) {
      if (isGroupAdminRole(member.role)) return LEVELS.GROUP_ADMIN;
      return LEVELS.USER;
    }
  }
  return cfg.groupSceneLevel;
}