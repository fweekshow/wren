import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { applyPreferIpv4Dns } from "./infra/preferIpv4Dns.js";

applyPreferIpv4Dns();

/**
 * Load env from the deploying app's working directory only.
 * Each Railway service / local `bun dev` run should set cwd to its app folder
 * (`apps/basemate-tba`, etc.) and keep a complete `.env` there — no repo-root `.env`.
 */
const cwd = process.cwd();
dotenv.config({ path: path.join(cwd, ".env") });

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function argvIncludes(fragment: string): boolean {
  return process.argv.some((arg) => arg.replace(/\\/g, "/").toLowerCase().includes(fragment));
}

/** Telegram app — skip XMTP wallet / DB encryption requirements. */
if (argvIncludes("basemate-telegram") || argvIncludes("telegramapp")) {
  process.env.TELEGRAM_ONLY ??= "1";
}

/** iMessage app / local REPL — skip XMTP wallet / DB encryption requirements. */
if (
  argvIncludes("basemate-imessage") ||
  argvIncludes("imessageapp") ||
  argvIncludes("imessage-repl")
) {
  process.env.IMESSAGE_ONLY ??= "1";
}

// Silence unused-variable lint for srcDir (kept for future monorepo helpers).
void srcDir;
