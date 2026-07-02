/**
 * WeChat echo bot — the canonical Spectrum consumer example.
 *
 * Imports the SDK by its published package name, exactly as an app would:
 *
 *   pnpm add photon-wechat-sdk @spectrum-ts/core
 *
 * Run it against a live agent-wechat container (build the SDK first so the
 * `photon-wechat-sdk` import resolves to ./dist):
 *
 *   pnpm build
 *   AGENT_WECHAT_TOKEN=$(cat ~/.config/agent-wechat/token) pnpm example:echo
 *
 * On first run it prints a VNC URL — scan the QR with your phone to log in.
 * Then message the account from another WeChat user and watch it echo back.
 */
import { Spectrum } from "@spectrum-ts/core";
import { wechat } from "photon-wechat-sdk";

const app = await Spectrum({
  providers: [
    wechat.config({
      baseUrl: process.env.AGENT_WECHAT_URL ?? "http://localhost:6174",
      token: process.env.AGENT_WECHAT_TOKEN,
      pollIntervalMs: 1500,
      // Each group sender is a distinct person; only reply when @-mentioned.
      groups: "mentionsOnly",
    }),
  ],
});

console.error("[echo-bot] listening for WeChat messages… (Ctrl-C to stop)");

for await (const [space, message] of app.messages) {
  const text = message.content.type === "text" ? message.content.text : undefined;
  if (!text) continue;
  console.error(`[echo-bot] ${message.sender?.id ?? "?"} in ${space.id}: ${text}`);
  await space.send(`echo: ${text}`);
}
