// 边缘函数入口：POST /news 接收外部新闻源的 JSON 推送。
import { handleNewsPush } from '../src/commands/libs/news-handler.js';
import type { EdgeContext } from '../src/libs/types.js';

export async function onRequestPost(context: EdgeContext): Promise<Response> {
  return handleNewsPush(context);
}
