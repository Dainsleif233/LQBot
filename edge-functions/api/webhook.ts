// 边缘函数入口：POST /api/webhook 接收 QQ 官方服务器推送。
import { handleWebhook } from '../../src/lib/handler.js';
import type { EdgeContext } from '../../src/lib/types.js';

export async function onRequest(context: EdgeContext): Promise<Response> {
  return handleWebhook(context);
}
