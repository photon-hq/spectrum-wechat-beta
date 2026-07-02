import { Spectrum } from "@spectrum-ts/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wechat } from "../src/index.js";
import { chat, MockAgentWeChat, msg } from "./mock-server.js";

/**
 * End-to-end echo through the REAL Spectrum runtime: an inbound WeChat message
 * flows provider → runtime → `app.messages`, and `space.send()` flows back
 * runtime → provider → the mock agent-wechat send endpoint.
 */
describe("echo bot over the Spectrum runtime", () => {
  let mock: MockAgentWeChat;
  let baseUrl: string;

  beforeEach(async () => {
    mock = new MockAgentWeChat();
    baseUrl = await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
  });

  it("echoes an inbound DM back to the same person via the real runtime", async () => {
    // Existing history at startup — the provider baselines this away so it is
    // never replayed as "new".
    mock.setChats([chat({ id: "wxid_alice", name: "Alice", lastMsgLocalId: 1 })]);
    mock.setMessages("wxid_alice", [
      msg({ chatId: "wxid_alice", localId: 1, sender: "wxid_alice", content: "old" }),
    ]);

    const app = await Spectrum({
      providers: [
        wechat.config({
          baseUrl,
          token: "test",
          pollIntervalMs: 100,
          groups: "include",
          waitForLogin: false,
          downloadMedia: false,
        }),
      ],
    });

    // Alice sends a NEW message after the bot is live (activity marker changes).
    mock.setChats([chat({ id: "wxid_alice", name: "Alice", lastMsgLocalId: 2 })]);
    mock.setMessages("wxid_alice", [
      msg({ chatId: "wxid_alice", localId: 2, sender: "wxid_alice", content: "ping" }),
      msg({ chatId: "wxid_alice", localId: 1, sender: "wxid_alice", content: "old" }),
    ]);

    // Consume exactly one inbound message, echo it, then stop.
    for await (const [space, message] of app.messages) {
      const text = message.content.type === "text" ? message.content.text : "";
      expect(message.sender?.id).toBe("wxid_alice");
      await space.send(`echo: ${text}`);
      break;
    }

    // The echo was delivered to the correct WeChat chat.
    expect(mock.sent).toEqual([{ chatId: "wxid_alice", text: "echo: ping" }]);

    await app.stop?.();
  });
});
