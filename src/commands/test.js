// /test —— 测试命令
// 群聊 at 与私聊场景均可；权限要求 0（所有人）。
// 返回：原消息、参数、参数数量、用户 openid、用户权限、用户昵称。
import { levelName } from '../lib/permissions.js';

export const name = 'test';
export const aliases = [];
export const description = '测试命令：回显消息与调用者信息';
export const scenes = ['group', 'private'];
export const minLevel = 0;

export async function handler(ctx) {
  const { args, raw, original, userOpenid, level, nick, scene } = ctx;
  const lines = [
    '【原消息】 ' + (original || raw),
    '【参数】 ' + (args.length ? args.join(' | ') : '(无)'),
    '【参数数量】 ' + args.length,
    '【用户 openid】 ' + (userOpenid || '(未知)'),
    '【用户权限】 ' + level + '（' + levelName(level) + '）',
    '【用户昵称】 ' + (nick || '(未知)'),
    '【场景】 ' + (scene === 'group' ? '群聊' : '私聊'),
  ];
  await ctx.reply(lines.join('\n'));
}
export default { name, aliases, description, scenes, minLevel, handler };
