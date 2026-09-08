// /openid —— 获取群内用户 openid
// 仅群聊场景；权限要求 3（超级管理员）。
// 用法：/openid <用户昵称> -> 在群成员列表中按昵称匹配，返回其 openid。
import * as qq from '../lib/qq.js';

export const name = 'openid';
export const aliases = [];
export const description = '获取群内用户的 openid（按昵称匹配）';
export const scenes = ['group']; // 仅群聊场景
export const minLevel = 3;

// 兼容不同返回结构：可能是 { members:[...] }、直接数组、或带 next/next_index 分页。
function normalizeMembers(data) {
  if (!data) return [];
  let arr = Array.isArray(data) ? data : (data.members || []);
  return arr.map(function (m) {
    return {
      member_openid: m.member_openid || m.memberOpenid || '',
      user_openid: m.user_openid || m.userOpenid || '',
      nick: m.nick || m.nickname || m.remark || '',
    };
  });
}

function nextCursor(data) {
  if (!data) return null;
  if (data.next !== undefined && data.next !== null && data.next !== '') return String(data.next);
  if (data.next_index !== undefined && data.next_index !== null && data.next_index !== '') return String(data.next_index);
  return null;
}

export async function handler(ctx) {
  const args = ctx.args;
  const cfg = ctx.cfg;
  const reply = ctx.reply;
  const groupOpenid = ctx.groupOpenid;
  const name = (args[0] || '').trim();
  if (!name) { await reply('用法：/openid <用户昵称>'); return; }
  if (!groupOpenid) { await reply('该命令仅可在群聊中使用。'); return; }

  let found = null;
  let after = '0';
  for (let page = 0; page < 20; page++) {
    let data;
    try { data = await qq.listGroupMembers(cfg, groupOpenid, 100, after); }
    catch (e) { await reply('拉取群成员失败：' + e.message); return; }

    const members = normalizeMembers(data);
    if (members.length === 0) break;

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const nick = m.nick || '';
      if (nick && (nick === name || nick.toLowerCase().indexOf(name.toLowerCase()) !== -1)) {
        found = m; break;
      }
    }
    if (found) break;

    const next = nextCursor(data);
    if (!next || next === after || next === '0') break;
    after = next;
  }

  if (!found) {
    await reply('未找到昵称为「' + name + '」的用户（如群很大请确认昵称准确）。');
    return;
  }
  const openid = found.user_openid || found.member_openid;
  await reply('用户「' + (found.nick || '') + '」\nopenid: ' + openid);
}
export default { name, aliases, description, scenes, minLevel, handler };
