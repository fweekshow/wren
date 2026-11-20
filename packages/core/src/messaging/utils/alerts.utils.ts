import {
  createAlertFromIntent,
  pendingAlerts,
  type ParsedAlertIntent,
  type SetupAlertResult,
} from "@/price-alerts/index.js";
import { stripMarkdown } from "@/imessage/outbound.js";
import type { MessagingPlatform } from "../handler.types.js";

export function replyFromResult(result: SetupAlertResult): string {
  if (result.kind === "created") return `alert #${result.alertId}: ${result.reply}`;
  return "reply" in result ? result.reply : "something went wrong setting that alert.";
}

export function parseAlertIds(text: string): number[] {
  const ids = Array.from(text.matchAll(/#?(\d+)\b/g), (match) => Number(match[1]))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)];
}

/** Keep an alert pending for a contract-address follow-up, else clear it. */
export function rememberPendingAlert(
  key: string,
  intent: Parameters<typeof pendingAlerts.set>[1],
  result: SetupAlertResult,
): void {
  if (
    result.kind === "ambiguous" ||
    result.kind === "unresolved" ||
    result.kind === "unpriced"
  ) {
    pendingAlerts.set(key, intent);
  } else {
    pendingAlerts.delete(key);
  }
}

export async function createMultipleImessageAlerts(args: {
  alertCore: {
    platform: MessagingPlatform;
    userKey: string;
    dmTarget: Record<string, unknown>;
    sourceConversationId: string;
    sourceIsGroup: boolean;
  };
  alertKey: string;
  intents: ParsedAlertIntent[];
}): Promise<string[]> {
  const replies: string[] = [];
  let created = 0;

  for (const intent of args.intents) {
    const result = await createAlertFromIntent(args.alertCore, intent);
    rememberPendingAlert(args.alertKey, intent, result);

    if (result.kind === "created") {
      created += 1;
      replies.push(stripMarkdown(replyFromResult(result)));
    } else if ("reply" in result) {
      replies.push(stripMarkdown(result.reply));
    }
  }

  if (created > 0) {
    return [`created ${created} alert${created === 1 ? "" : "s"}.`, ...replies];
  }
  return replies;
}
