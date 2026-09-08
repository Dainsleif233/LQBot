// QQ 官方机器人 Webhook 签名：全部使用 Ed25519。
// 注意：本运行时(EdgeOne edge)的 WebCrypto 不支持 Ed25519，故使用 vendored tweetnacl。
// 参考官方文档 sign.md / event-emit.md：
//   - 地址校验(op=13)：msg = event_ts + plain_token，用由 botSecret 派生的私钥签名。
//   - 事件校验：      msg = timestamp + rawBody，     与 X-Signature-Ed25519 比对。
// 种子派生（与官方 Go 示例一致）：把 secret 重复拼接直到 >=32 字节，再截断到 32 字节。

import { nacl } from './tweetnacl.js';

function deriveSeed(secret) {
  let seed = String(secret);
  while (seed.length < 32) seed += secret;
  return new TextEncoder().encode(seed).slice(0, 32);
}

function bytesToHex(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// 用 botSecret 派生的 Ed25519 私钥对 messageBytes 签名（确定性，与 Go ed25519.NewKeyFromSeed 一致）。
function ed25519SignHex(secret, messageBytes) {
  const seed = deriveSeed(secret);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(messageBytes, kp.secretKey);
  return bytesToHex(sig);
}

// 地址校验响应签名：msg = event_ts + plain_token
export async function signWebhookChallenge(secret, plainToken, eventTs) {
  const msg = new TextEncoder().encode(String(eventTs) + String(plainToken));
  return ed25519SignHex(secret, msg);
}

// 事件签名校验：msg = timestamp + rawBody
// Ed25519(RFC8032) 确定性，重签并比对等价于用公钥验签，且绕开运行时导出公钥的兼容问题。
export async function verifyWebhookSignature(secret, timestamp, rawBody, signatureHex) {
  const msg = new TextEncoder().encode(String(timestamp) + rawBody);
  const expected = ed25519SignHex(secret, msg);
  const provided = String(signatureHex || '').toLowerCase();
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= (expected.charCodeAt(i) ^ provided.charCodeAt(i));
  return diff === 0;
}
