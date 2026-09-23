/**
 * set-webhook.ts — register this deployment's webhook URL with Telegram.
 *
 * Run once after deploying, and again whenever APP_URL changes. Telegram only
 * ever delivers to one webhook per bot, so re-running this replaces the old one.
 *
 * Usage: npm run telegram:set-webhook
 */

import "./_bootstrap";
import { callTelegram } from "@/lib/alerter/telegram";
import { env } from "@/lib/env";

interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
}

async function main(): Promise<void> {
  const url = `${env.appUrl}/api/telegram/webhook`;

  if (env.appUrl.startsWith("http://")) {
    console.error(
      `APP_URL is ${env.appUrl}\n` +
        `Telegram requires HTTPS and will not deliver to a plain http:// or localhost URL.\n` +
        `Set APP_URL to your deployed https:// address first.`,
    );
    process.exit(1);
  }

  const me = await callTelegram<{ username: string; first_name: string }>("getMe", {});
  console.log(`Bot: @${me.username} (${me.first_name})\n`);

  console.log(`Registering webhook: ${url}`);
  await callTelegram("setWebhook", {
    url,
    secret_token: env.telegramWebhookSecret,
    // We only care about messages; ignoring the rest cuts pointless traffic
    // and therefore pointless function invocations.
    allowed_updates: ["message"],
    // Anything queued while the webhook was unset is stale by definition.
    drop_pending_updates: true,
    max_connections: 10,
  });

  const info = await callTelegram<WebhookInfo>("getWebhookInfo", {});
  console.log("\nWebhook registered:");
  console.log(`  url:               ${info.url}`);
  console.log(`  pending updates:   ${info.pending_update_count ?? 0}`);
  console.log(`  max connections:   ${info.max_connections ?? "-"}`);
  if (info.last_error_message) {
    console.log(`  last error:        ${info.last_error_message}`);
    console.log(`  (an old error here is normal right after registering)`);
  }

  // Register the command list so Telegram shows a menu in the chat.
  await callTelegram("setMyCommands", {
    commands: [
      { command: "status", description: "Cycles, sources, AI usage, Vercel budget" },
      { command: "last", description: "The last 5 alerts" },
      { command: "stats", description: "Published to alerted latency" },
      { command: "sources", description: "Every feed and its health" },
      { command: "pause", description: "Stop alerting (keeps deduping)" },
      { command: "resume", description: "Start alerting again" },
      { command: "test", description: "Send a sample alert" },
      { command: "help", description: "Show all commands" },
    ],
  });
  console.log("\nCommand menu registered. Send /help to the bot to check.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
