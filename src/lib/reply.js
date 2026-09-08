// 根据场景把反馈消息发到正确的位置：群聊 -> 群；私聊 -> 用户。
// 被动回复：携带事件消息 id 作为 event_id（群 5 分钟、单聊 60 分钟内有效）。
import * as qq from './qq.js';

export function createReply(cfg, event, scene) {
  const d = (event && event.d) || {};
  const messageId = d.id || (event && event.id) || '';
  if (scene === 'group') {
    const groupOpenid = d.group_openid || '';
    return async function reply(content) {
      if (!groupOpenid) throw new Error('缺少 group_openid，无法回复');
      return qq.sendGroupMessage(cfg, groupOpenid, content, messageId);
    };
  }
  // private
  const userOpenid = (d.author && d.author.user_openid) || d.user_openid || '';
  return async function reply(content) {
    if (!userOpenid) throw new Error('缺少 user_openid，无法回复');
    return qq.sendC2CMessage(cfg, userOpenid, content, messageId);
  };
}
