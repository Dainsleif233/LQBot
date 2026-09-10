// 根据场景把反馈消息发到正确的位置：群聊 -> 群；私聊 -> 用户。
// 被动回复：携带消息 id（d.id）作为 msg_id（群 5 分钟、单聊 60 分钟内有效）。
// 同一 msg_id 多次被动回复必须递增 msg_seq（相同 msg_id+msg_seq 会失败），本文件自动递增。
// 窗口内额度：单聊 4 次 / 群聊 5 次（超出后 QQ 拒绝）。
import * as qq from './qq.js';
import type { Config, MediaType, Scene } from './types.js';

export interface SceneReply {
  /** 文本（群聊开头自动加换行与 @ 上下文分隔） */
  reply: (content: string) => Promise<void>;
  /** Markdown（msg_type=2） */
  replyMarkdown: (content: string) => Promise<void>;
  /** 富媒体（msg_type=7）：先 URL 上传拿 file_info（srv_send_msg=false），再被动发送 */
  replyMedia: (fileType: MediaType, url: string) => Promise<void>;
}

export function createReply(cfg: Config, event: any, scene: Scene): SceneReply {
  const d = (event && event.d) || {};
  // 被动回复用 msg_id = d.id（消息 id，形如 ROBOT1.0_...），不是事件 id。
  const messageId = d.id || '';
  if (!messageId) throw new Error('事件缺少消息 id（d.id），无法被动回复');
  const openid = scene === 'group'
    ? (d.group_openid || '')
    : ((d.author && d.author.user_openid) || d.user_openid || '');
  // 同一 msg_id 的第 N 次被动回复：msg_seq 从 1 递增，重复的 msg_id+msg_seq 会被 QQ 拒绝
  let seq = 0;
  function ensureOpenid(): void {
    if (!openid) throw new Error(scene === 'group' ? '缺少 group_openid，无法回复' : '缺少 user_openid，无法回复');
  }
  function passived(body: Record<string, unknown>): Record<string, unknown> {
    if (!messageId) return body; // 无 msg_id 时只能作为主动消息发送（受月度额度限制）
    seq += 1;
    return { ...body, msg_id: messageId, msg_seq: seq };
  }
  return {
    // 文本：群聊回复开头加一个换行，与 @ 上下文分隔
    reply: (content: string) => {
      ensureOpenid();
      const text = scene === 'group' ? '\n' + content : content;
      return qq.sendBody(cfg, scene, openid, passived({ content: text, msg_type: 0 })).then(() => undefined);
    },
    replyMarkdown: (content: string) => {
      ensureOpenid();
      return qq.sendBody(cfg, scene, openid, passived({ msg_type: 2, markdown: { content } })).then(() => undefined);
    },
    replyMedia: async (fileType: MediaType, url: string): Promise<void> => {
      ensureOpenid();
      const fileInfo = await qq.uploadFile(cfg, scene, openid, fileType, url);
      await qq.sendBody(cfg, scene, openid, passived({ msg_type: 7, media: { file_info: fileInfo } }));
    },
  };
}
