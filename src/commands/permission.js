// /permission —— 权限管理命令
// 群聊 at 与私聊场景均可；权限要求 3（超级管理员）。
// 用法：
//   /permission              -> 返回当前用户场景权限
//   /permission <user_openid> -> 返回目标用户当前场景权限（含 KV 覆盖值）
//   /permission <user_openid> <int> -> 设置目标用户权限等级(0-3)
import { resolveLevel, LEVELS, levelName } from '../lib/permissions.js';

export const name = 'permission';
export const aliases = [];
export const description = '权限管理：查询或设置用户权限（等级 0-3）';
export const scenes = ['group', 'private'];
export const minLevel = LEVELS.SUPER_ADMIN; // 3

export async function handler(ctx) {
  const { args, cfg, reply, level, scene, groupOpenid, memberOpenid } = ctx;
  const target = args[0];
  const value = args[1];

  // 无参数：返回当前用户场景权限
  if (!target) {
    await reply('你当前的权限等级为：' + level + '（' + levelName(level) + '）');
    return;
  }

  // 查询目标用户
  if (value === undefined) {
    if (!cfg.kv) {
      await reply('KV 未绑定，无法查询存储的权限；返回场景默认。');
      return;
    }
    let stored = null;
    try {
      stored = await cfg.kv.get('perm:' + target);
    } catch (_) {}
    if (stored !== null && stored !== undefined && stored !== '') {
      const n = parseInt(stored, 10);
      await reply('用户 ' + target + ' 的权限（已设置）为：' + n + '（' + levelName(n) + '）');
      return;
    }
    // 无存储值 -> 场景默认
    const resolved = await resolveLevel(cfg, { scene, userOpenid: target, groupOpenid, memberOpenid });
    await reply('用户 ' + target + ' 当前场景权限为：' + resolved + '（' + levelName(resolved) + '，未单独设置）');
    return;
  }

  // 设置目标用户权限
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0 || n > 3) {
    await reply('权限值必须为 0-3 的整数。');
    return;
  }
  if (!cfg.kv) {
    await reply('KV 未绑定，无法持久化权限设置。请先在控制台绑定 KV 命名空间。');
    return;
  }
  try {
    await cfg.kv.put('perm:' + target, String(n));
  } catch (e) {
    await reply('写入 KV 失败：' + e.message);
    return;
  }
  await reply('已将用户 ' + target + ' 的权限设置为：' + n + '（' + levelName(n) + '）');
}
export default { name, aliases, description, scenes, minLevel, handler };
