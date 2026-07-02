/**
 * Interactive WeChat smoke test, modeled after the tiny iMessage/RCS listener.
 *
 * It exercises both sides of the SDK against a live agent-wechat container:
 *   1. REST health/auth check.
 *   2. Spectrum provider startup and QR login flow.
 *   3. Optional filehelper self-send/read-back check.
 *   4. Live inbound handling from your phone, with echo replies and commands.
 *
 * Run:
 *   pnpm build
 *   AGENT_WECHAT_TOKEN=$(cat ~/.config/agent-wechat/token) pnpm example:interactive-smoke
 *
 * Send the bot `/help`, `/ping`, `/whoami`, or `/run` from another WeChat
 * account. In groups, the default policy is `mentionsOnly`, so mention the bot.
 *
 * Env knobs:
 *   AGENT_WECHAT_URL             base URL (default http://localhost:6174)
 *   AGENT_WECHAT_TOKEN           bearer token, otherwise token file fallback
 *   WECHAT_GROUPS                exclude | include | mentionsOnly (default mentionsOnly)
 *   WECHAT_SMOKE_ECHO            set 0/false to log only, no automatic replies
 *   WECHAT_SMOKE_FILEHELPER      set 0/false to skip the filehelper round trip
 *   WECHAT_SMOKE_READ_BACK_SECS  filehelper read-back timeout (default 60)
 */
import { randomUUID } from "node:crypto";
import {
  Spectrum,
  markdown,
  richlink,
  type Content,
  type Message,
  type Space,
} from "@spectrum-ts/core";
import {
  AgentWeChatClient,
  wechat,
  wechatConfigSchema,
  type WeChatConfig,
} from "photon-wechat-sdk";

const PREFIX = "[interactive-smoke]";
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const HELP_TEXT = [
  `interactive-smoke ${RUN_ID}`,
  "Commands:",
  "/ping - send a pong with the run id",
  "/whoami - print the Spectrum/WeChat ids seen for you",
  "/run - send reply, text, markdown, and richlink samples",
  "/help - show this message",
].join("\n");

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const config = wechatConfigSchema.parse({
  baseUrl: process.env.AGENT_WECHAT_URL ?? "http://localhost:6174",
  token: process.env.AGENT_WECHAT_TOKEN,
  pollIntervalMs: numberEnv("WECHAT_POLL_MS", 1500),
  sendPacingMs: numberEnv("WECHAT_SEND_PACING_MS", 1000),
  groups: groupPolicyFromEnv(),
  downloadMedia: boolEnv("WECHAT_DOWNLOAD_MEDIA", false),
});

const echoReplies = boolEnv("WECHAT_SMOKE_ECHO", true);
const runFilehelperCheck = boolEnv("WECHAT_SMOKE_FILEHELPER", true);
const api = new AgentWeChatClient({ baseUrl: config.baseUrl, token: config.token });
const seenMessageIds = new Set<string>();

let app: Awaited<ReturnType<typeof Spectrum>> | undefined;
let failed = false;
let stopping = false;
let handled = 0;
let replies = 0;

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await main().catch(async (error) => {
  failed = true;
  console.error(`${PREFIX} fatal: ${errorMessage(error)}`);
  await shutdown("fatal");
});

async function main(): Promise<void> {
  console.log(`${PREFIX} run=${RUN_ID}`);
  console.log(`${PREFIX} baseUrl=${config.baseUrl} groups=${config.groups} echo=${echoReplies}`);

  const health = await api.health().catch((error) => ({ status: `error: ${errorMessage(error)}` }));
  check("health", health.status === "ok", `status=${health.status}`);
  if (health.status !== "ok") {
    throw new Error("agent-wechat health check failed");
  }

  const auth = await api.authStatus().catch((error) => ({
    status: `error: ${errorMessage(error)}`,
    loggedInUser: undefined,
  }));
  console.log(`${PREFIX} auth status=${auth.status} user=${auth.loggedInUser ?? "(unknown)"}`);

  app = await Spectrum({
    providers: [wechat.config(config)],
  });

  console.log(`${PREFIX} Spectrum connected; send /help, /ping, /whoami, or /run now.`);

  if (runFilehelperCheck) {
    await filehelperRoundTrip(config);
  } else {
    console.log(`${PREFIX} SKIP filehelper round trip`);
  }

  for await (const [space, message] of app.messages) {
    void handleMessage(space, message).catch((error) => {
      failed = true;
      console.error(`${PREFIX} handler failed: ${errorMessage(error)}`);
    });
  }

  await shutdown("message stream ended");
}

async function handleMessage(space: Space, message: Message): Promise<void> {
  if (seenMessageIds.has(message.id)) return;
  remember(message.id);
  handled += 1;

  const text = contentText(message.content)?.trim();
  const contentType = contentKind(message.content);
  const senderId = message.sender?.id ?? "(unknown)";
  const meta = wechatMeta(message);

  console.log(
    JSON.stringify({
      event: "inbound",
      runId: RUN_ID,
      messageId: message.id,
      spaceId: space.id,
      senderId,
      senderName: meta.senderName,
      chatType: meta.chatType,
      wechatType: meta.wechatType,
      contentType,
      text: text ? truncate(text, 500) : null,
    }),
  );

  await readBestEffort(message);
  if (!echoReplies) return;

  if (text?.startsWith("/")) {
    await handleCommand(space, message, text);
    return;
  }

  const reply = text
    ? `pong ${RUN_ID}: ${text}`
    : `pong ${RUN_ID}: received ${contentType}`;
  await sendText(space, reply);
}

async function handleCommand(
  space: Space,
  message: Message,
  text: string,
): Promise<void> {
  const command = text.split(/\s+/, 1)[0]?.toLowerCase();

  switch (command) {
    case "/help":
      await sendText(space, HELP_TEXT);
      return;

    case "/ping":
      await sendText(space, `pong ${RUN_ID} ${new Date().toISOString()}`);
      return;

    case "/whoami":
      await sendText(
        space,
        [
          `interactive-smoke ${RUN_ID}`,
          `space.id=${space.id}`,
          `sender.id=${message.sender?.id ?? "(unknown)"}`,
          `senderName=${wechatMeta(message).senderName ?? "(unknown)"}`,
          `chatType=${wechatMeta(message).chatType ?? "(unknown)"}`,
          `message.id=${message.id}`,
        ].join("\n"),
      );
      return;

    case "/run":
      await runSweep(space, message);
      return;

    default:
      await sendText(space, `unknown command: ${command ?? text}\n\n${HELP_TEXT}`);
  }
}

async function runSweep(space: Space, trigger: Message): Promise<void> {
  const sweepId = `${RUN_ID}-${randomUUID().slice(0, 8)}`;
  const results: string[] = [];

  const steps: Array<{ name: string; send: () => Promise<void> }> = [
    {
      name: "reply",
      send: async () => {
        await trigger.reply(`interactive-smoke ${sweepId}: reply sample.`);
      },
    },
    {
      name: "text",
      send: async () => {
        await space.send(`interactive-smoke ${sweepId}: text sample.`);
      },
    },
    {
      name: "markdown",
      send: async () => {
        await space.send(markdown(`**interactive-smoke ${sweepId}** markdown sample`));
      },
    },
    {
      name: "richlink",
      send: async () => {
        await space.send(richlink("https://photon.codes/spectrum"));
      },
    },
  ];

  await sendText(space, `interactive-smoke ${sweepId}: starting command sweep.`);

  for (const step of steps) {
    try {
      console.log(`${PREFIX} ${sweepId} sending ${step.name} to ${space.id}`);
      await step.send();
      replies += 1;
      results.push(`${step.name}=ok`);
    } catch (error) {
      failed = true;
      const message = errorMessage(error);
      console.error(`${PREFIX} ${sweepId} ${step.name} failed: ${message}`);
      results.push(`${step.name}=fail`);
      await sendText(space, `interactive-smoke ${sweepId}: ${step.name} failed: ${message}`);
    }
  }

  await sendText(space, `interactive-smoke ${sweepId}: complete. ${results.join(", ")}`);
}

async function sendText(space: Space, text: string): Promise<void> {
  await space.startTyping();
  await delay(250);
  try {
    await space.send(text);
    replies += 1;
  } finally {
    await space.stopTyping().catch(() => {});
  }
}

async function readBestEffort(message: Message): Promise<void> {
  try {
    await message.read();
    console.log(JSON.stringify({ event: "read", messageId: message.id }));
  } catch (error) {
    console.warn(`${PREFIX} read receipt failed: ${errorMessage(error)}`);
  }
}

async function filehelperRoundTrip(currentConfig: WeChatConfig): Promise<void> {
  const nonce = `interactive-smoke ${RUN_ID} ${randomUUID().slice(0, 8)}`;
  const sent = await api.sendText("filehelper", nonce).catch((error) => ({
    success: false,
    error: errorMessage(error),
  }));

  check("filehelper-send", sent.success === true, sent.error ?? nonce);
  if (!sent.success) return;

  const timeoutMs = numberEnv("WECHAT_SMOKE_READ_BACK_SECS", 60) * 1000;
  const deadline = Date.now() + timeoutMs;
  let found = false;

  while (Date.now() < deadline && !found) {
    await delay(2500);
    const messages = await api.listMessages("filehelper", currentConfig.messageLimit).catch(() => []);
    found = messages.some((message) => message.content.includes(nonce));
  }

  check(
    "filehelper-read-back",
    found,
    found ? "nonce found in filehelper history" : `nonce not visible within ${timeoutMs / 1000}s`,
  );
}

async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;

  console.log(`${PREFIX} stopping: ${reason}`);
  await app?.stop?.().catch((error: unknown) => {
    failed = true;
    console.warn(`${PREFIX} stop failed: ${errorMessage(error)}`);
  });
  console.log(`${PREFIX} handled=${handled} replies=${replies} result=${failed ? "FAIL" : "PASS"}`);
  process.exit(failed ? 1 : 0);
}

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${PREFIX} ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed = true;
}

function contentText(content: Content): string | null {
  if (content.type === "text") return content.text;
  if (content.type === "markdown") return content.markdown;
  return null;
}

function contentKind(content: Content): string {
  return content.type;
}

function wechatMeta(message: Message): {
  senderName?: string;
  chatType?: string;
  wechatType?: number;
} {
  const record = message as unknown as Record<string, unknown>;
  const senderName = typeof record.senderName === "string" ? record.senderName : undefined;
  const chatType = typeof record.chatType === "string" ? record.chatType : undefined;
  const wechatType = typeof record.wechatType === "number" ? record.wechatType : undefined;
  return { senderName, chatType, wechatType };
}

function remember(messageId: string): void {
  seenMessageIds.add(messageId);
  if (seenMessageIds.size <= 1000) return;
  const first = seenMessageIds.values().next().value;
  if (first) seenMessageIds.delete(first);
}

function groupPolicyFromEnv(): "exclude" | "include" | "mentionsOnly" {
  const value = process.env.WECHAT_GROUPS;
  if (value === "exclude" || value === "include" || value === "mentionsOnly") {
    return value;
  }
  return "mentionsOnly";
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return fallback;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
