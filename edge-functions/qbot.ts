// 边缘函数入口：POST /qbot 接收 QQ 官方服务器推送。
// 只导出 onRequestPost：非 POST 请求不匹配路由、不进函数（方法筛选交给路由层，不在 handler 里判）。
import { handleWebhook } from '../src/libs/handler.js';
import type { EdgeContext } from '../src/libs/types.js';

export async function onRequestPost(context: EdgeContext): Promise<Response> {
  return handleWebhook(context);
}
