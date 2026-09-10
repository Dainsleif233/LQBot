// /permission —— 权限管理命令
// 群聊 at 与私聊场景均可；权限要求 3（超级管理员）。
// 用法：/permission [<user_openid> [<0-3>|reset]]
import { resolveLevel, LEVELS, levelName, PERM_NS } from '../lib/permissions.js';
import { defineCommand } from '../lib/define.js';
import type { CommandContext } from '../lib/types.js';

export default defineCommand({
  name: 'permission',
  aliases: ['perm'], // 别名 /perm
  description: '权限管理',
  scenes: ['group', 'private'],
  minLevel: LEVELS.SUPER_ADMIN, // 3
  async handler(ctx: CommandContext): Promise<void> {
    const { args, cfg, reply, level, scene, groupOpenid, memberOpenid, memberInfo, userOpenid } = ctx;
    const target = args[0];
    const value = args[1];
    // 无参数：返回当前用户场景权限
    if (!target) {
      await reply('你当前的权限等级为：' + level + '（' + levelName(level) + '）');
      return;
    }
    // 权限覆盖存在「用户场景变量」：实际 key = perm:user:<target>:level
    const store = cfg.storage.ns(PERM_NS).user(target);
    if (!store) {
      await reply('目标用户 openid 无效。');
      return;
    }
    // 查询目标用户
    if (value === undefined) {
      if (!store.available) {
        await reply('KV 未绑定，无法查询存储的权限；返回场景默认。');
      } else {
        let stored: string | null = null;
        try {
          stored = await store.get('level');
        } catch (_) {}
        if (stored !== null && stored !== undefined && stored !== '') {
          const n = parseInt(stored, 10);
          await reply('用户 ' + target + ' 的权限（已设置）为：' + n + '（' + levelName(n) + '）');
          return;
        }
      }
      // 无存储值 -> 场景默认
      // 只有查询调用者本人时才带上其群成员信息；查别人时无法得知对方的群角色，交给场景默认值
      const isSelf = !!userOpenid && target === userOpenid;
      const resolved = await resolveLevel(cfg, {
        scene,
        userOpenid: target,
        groupOpenid,
        memberOpenid: isSelf ? memberOpenid : null,
        memberInfo: isSelf ? memberInfo : null,
      });
      await reply('用户 ' + target + ' 当前场景权限为：' + resolved + '（' + levelName(resolved) + '，未单独设置）');
      return;
    }
    // 清除覆盖：/permission <openid> reset（也接受 delete / clear）
    const op = String(value).toLowerCase();
    if (op === 'reset' || op === 'delete' || op === 'clear') {
      if (!store.available) {
        await reply('KV 未绑定，无法清除权限设置。');
        return;
      }
      try {
        await store.del('level');
      } catch (e) {
        await reply('删除 KV 失败：' + (e as Error).message);
        return;
      }
      await reply('已清除用户 ' + target + ' 的权限覆盖，回到场景默认值。');
      return;
    }
    // 设置目标用户权限
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || n < 0 || n > 3) {
      await reply('权限值必须为 0-3 的整数，或 reset 以清除覆盖。');
      return;
    }
    if (!store.available) {
      await reply('KV 未绑定，无法持久化权限设置。请先在控制台绑定 KV 命名空间。');
      return;
    }
    try {
      await store.set('level', String(n));
    } catch (e) {
      await reply('写入 KV 失败：' + (e as Error).message);
      return;
    }
    await reply('已将用户 ' + target + ' 的权限设置为：' + n + '（' + levelName(n) + '）');
  },
});
