// Test LINE webhook signature locally or against a deployed URL.
//   bun run scripts/line-webhook-test.ts
//   bun run scripts/line-webhook-test.ts https://som.develyst.online/api/webhooks/line
//
// ถ้า curl/เปิดใน browser ได้ {"error":"invalid signature"} — ปกติ (ไม่มี X-Line-Signature)
// สคริปต์นี้สร้าง signature ถูกต้องจาก LINE_CHANNEL_SECRET ใน .env

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadSecret(): string {
  const fromEnv = process.env.LINE_CHANNEL_SECRET?.trim();
  if (fromEnv) return fromEnv;
  try {
    const dot = readFileSync(resolve(import.meta.dir, "../.env"), "utf8");
    const m = dot.match(/^LINE_CHANNEL_SECRET=(.+)$/m);
    if (m?.[1]) return m[1].trim();
  } catch {
    /* no .env */
  }
  throw new Error("ตั้ง LINE_CHANNEL_SECRET ใน .env หรือ env ก่อน");
}

const secret = loadSecret();
const body = JSON.stringify({ destination: "U0000000000000000000000000000000", events: [] });
const signature = createHmac("sha256", secret).update(body).digest("base64");
const url = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 3001}/api/webhooks/line`;

console.log("URL:", url);
console.log("secret length:", secret.length, "(ควรเป็น 32 ตัวอักษร hex จาก LINE Console)");

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-line-signature": signature,
  },
  body,
});

const text = await res.text();
console.log("HTTP", res.status, text);

if (res.status === 200) {
  console.log("\n✅ signature ถูกต้อง — LINE Console กด Verify ควรผ่าน (ถ้า server ใช้ secret เดียวกัน)");
} else if (text.includes("invalid signature")) {
  console.log("\n❌ secret บน server ไม่ตรงกับ .env นี้ หรือ proxy แก้ body/header");
  console.log("   → ตรวจ LINE Developers → Basic settings → Channel secret");
  console.log("   → ตรวจ .env บน server (ไม่ใช่แค่เครื่อง dev) แล้ว restart backend");
}
