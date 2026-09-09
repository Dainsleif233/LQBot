// QQ 官方机器人 Webhook 签名：全部使用 Ed25519。
// 注意：本运行时(EdgeOne edge)的 WebCrypto 不支持 Ed25519，故使用 vendored tweetnacl。
// 参考官方文档 sign.md / event-emit.md：
//   - 地址校验(op=13)：msg = event_ts + plain_token，用由 botSecret 派生的私钥签名。
//   - 事件校验：      msg = timestamp + rawBody，     与 X-Signature-Ed25519 比对。
// 种子派生（与官方 Go 示例一致）：把 secret 重复拼接直到 >=32 字节，再截断到 32 字节。
import { nacl } from './tweetnacl.js';
// 注意：按 UTF-16 字符重复拼接再取 UTF-8 前 32 字节。官方 Go 示例按字节拼接，
// 两者仅在非 ASCII 密钥下可能不同；QQ AppSecret 为 ASCII，已用官方 KAT 验证一致。
function deriveSeed(secret: string): Uint8Array {
  let seed = String(secret);
  while (seed.length < 32) seed += secret;
  return new TextEncoder().encode(seed).slice(0, 32);
}
function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
// 用 botSecret 派生的 Ed25519 私钥对 messageBytes 签名（确定性，与 Go ed25519.NewKeyFromSeed 一致）。
function ed25519SignHex(secret: string, messageBytes: Uint8Array): string {
  const seed = deriveSeed(secret);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(messageBytes, kp.secretKey);
  return bytesToHex(sig);
}
// 地址校验响应签名：msg = event_ts + plain_token
export async function signWebhookChallenge(secret: string, plainToken: string, eventTs: string | number): Promise<string> {
  if (!secret) throw new Error('签名密钥未配置');
  const msg = new TextEncoder().encode(String(eventTs) + String(plainToken));
  return ed25519SignHex(secret, msg);
}
// 事件签名校验：msg = timestamp + rawBody
// Ed25519(RFC8032) 确定性，重签并比对等价于用公钥验签，且绕开运行时导出公钥的兼容问题。
export async function verifyWebhookSignature(secret: string, timestamp: string, rawBody: string, signatureHex: string | null | undefined): Promise<boolean> {
  // 空密钥直接拒绝：既不可能验签成功，也避免 deriveSeed 对空串无限循环
  if (!secret) return false;
  const msg = new TextEncoder().encode(String(timestamp) + rawBody);
  const expected = ed25519SignHex(secret, msg);
  const provided = String(signatureHex || '').toLowerCase();
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= (expected.charCodeAt(i) ^ provided.charCodeAt(i));
  return diff === 0;
}