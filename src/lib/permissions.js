// 权限系统：挡位进阶，3 > 2 > 1 > 0。
// 解析顺序：超级管理员(env,3) > KV 显式覆盖(0-3) > 场景默认值。

export const LEVELS = { SUPER_ADMIN: 3, GLOBAL_ADMIN: 2, GROUP_ADMIN: 1, USER: 0 };

export const LEVEL_NAMES = {
  3: '超级管理员',
  2: '全局管理员',
  1: '群聊管理员',
  0: '普通用户',
};

export function levelName(n) {
  return LEVEL_NAMES[n] || ('未知(' + n + ')');
}

// 真实群管身份识别（可选，依赖群成员接口的 role 字段）。
// QQ 群成员接口返回结构官方文档尚未完整开放，这里按常见形态兼容处理；
// 如实测 role 字段不同，请按控制台返回调整本函数。
function isGroupAdminRole(role) {
  if (role === undefined || role === null) return false;
  if (typeof role === 'string') return /admin|owner|管理员|群主/i.test(role);
  if (typeof role === 'number') return role >= 2; // 假定 1=普通, 2=管理员/群主（需按实际校准）
  return false;
}

// 解析某用户在某场景下的有效权限等级。
export async function resolveLevel(cfg, { scene, userOpenid, groupOpenid, memberOpenid, memberInfo }) {
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
      try { member = await import('./qq.js').then(qq => qq.getGroupMember(cfg, groupOpenid, memberOpenid)); }
      catch (_) { member = null; }
    }
    if (member) {
      if (isGroupAdminRole(member.role)) return LEVELS.GROUP_ADMIN;
      return LEVELS.USER;
    }
  }
  return cfg.groupSceneLevel;
}
