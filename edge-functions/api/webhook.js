// 边缘函数入口：POST /api/webhook 接收 QQ 官方服务器推送。
import { handleWebhook } from '../../src/lib/handler.js';

export async function onRequest(context) {
  return handleWebhook(context);
}
