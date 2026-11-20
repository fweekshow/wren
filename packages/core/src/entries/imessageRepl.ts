import * as readline from "node:readline/promises";

import "@/load-env.js";

import { config } from "@/config/config.js";
import { connectDb } from "@/discovery/db.js";
import { createImessageHandler } from "@/messaging/handler.js";
import { formatOutboundForRepl, type ImessageOutbound } from "@/imessage/outbound.js";

export interface ImessageReplOptions {
  /** Simulated iMessage sender id (maps to custodial wallet + chat history). */
  senderId: string;
  /** Send one message and exit instead of an interactive session. */
  message?: string;
}

function parseReplArgs(argv: string[]): ImessageReplOptions {
  let senderId = process.env.IMESSAGE_REPL_SENDER_ID ?? "local-dev-user";
  let message: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sender" && argv[i + 1]) {
      senderId = argv[++i];
    } else if ((arg === "--message" || arg === "-m") && argv[i + 1]) {
      message = argv[++i];
    } else if (!arg.startsWith("-")) {
      message = argv.slice(i).join(" ");
      break;
    }
  }

  return { senderId, message };
}

function printBotReply(chunks: ImessageOutbound[]): void {
  for (const chunk of chunks) {
    console.log(`\n🤖 basemate:\n${formatOutboundForRepl(chunk)}\n`);
  }
}

async function dispatchMessage(
  handler: ReturnType<typeof createImessageHandler>,
  senderId: string,
  text: string,
): Promise<void> {
  console.log(`📥 you (${senderId}): ${text}`);
  try {
    const chunks = await handler.handleInboundText({
      senderId,
      conversationId: `repl-${senderId}`,
      text,
    });
    printBotReply(chunks);
  } catch (err) {
    console.error("⚠️ [iMessage REPL] failed to handle message:", err);
    console.log("\n🤖 basemate:\nhmm, something went wrong on my end — try again in a sec\n");
  }
}

export async function runImessageRepl(argv = process.argv.slice(2)): Promise<void> {
  const { senderId, message } = parseReplArgs(argv);

  await connectDb();
  // Tables are now managed by Drizzle migrations — run `bun db:migrate` to apply.

  const handler = createImessageHandler();

  console.log("💬 iMessage REPL — local testing without Spectrum or a real iMessage line");
  console.log(`   sender: ${senderId}`);
  console.log("   commands: /quit  /sender <id>");
  if (!config.spectrum.projectId) {
    console.log("   (PHOTON_* not set — that's fine for the REPL)");
  }
  console.log("");

  if (message) {
    await dispatchMessage(handler, senderId, message);
    return;
  }

  let activeSenderId = senderId;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      const line = (await rl.question(`you (${activeSenderId})> `)).trim();
      if (!line) continue;

      if (line === "/quit" || line === "/exit") break;

      if (line.startsWith("/sender ")) {
        const next = line.slice("/sender ".length).trim();
        if (!next) {
          console.log("usage: /sender <id>");
          continue;
        }
        activeSenderId = next;
        console.log(`sender → ${activeSenderId}`);
        continue;
      }

      await dispatchMessage(handler, activeSenderId, line);
    }
  } finally {
    rl.close();
  }
}
