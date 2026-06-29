// Manual LINE push test — run once a recipient LINE userId is known.
//   bun run scripts/line-push.ts <lineUserId> [text]
// Verifies the channel access token + delivery end-to-end without the worker.

import { getBotInfo, pushMessage } from "../src/lib/line-client";

const [to, ...rest] = process.argv.slice(2);
const text = rest.join(" ") || "ทดสอบการแจ้งเตือนจากระบบตารางเรียน ✅";

const info = await getBotInfo();
console.log("bot/info:", info);

if (!to) {
  console.log("\nusage: bun run scripts/line-push.ts <lineUserId> [text]");
  console.log("(token is valid if bot/info printed above)");
  process.exit(0);
}

await pushMessage(to, [{ type: "text", text }]);
console.log(`✅ pushed to ${to}: ${text}`);
process.exit(0);
