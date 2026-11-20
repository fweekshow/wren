/**
 * app.handlers — read-only dashboard tools that answer "show me my …" questions
 * in chat AND hand the user a deep link into the /app web dashboard.
 *
 * These back the same data the dashboard renders (see app.router.ts):
 *   get_recent_activity — recent transactions        → /app#activity
 *   get_recent_sends    — person-to-person sends      → /app#sends
 *   get_payment_mode    — confirm-each vs. automatic  → /app#settings
 *
 * Balance (#home) and yield positions (#earn) reuse the existing wallet/earn
 * tools; those append the same deep link via appendAppLink in toolbox.ts.
 */

import { TxConfirmationAdapter } from "@/discovery/adapters/txConfirmation.adapter.js";
import { DEFAULT_AUTO_SEND_LIMIT_USD, WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { appLink } from "@/discovery/ai/appLinks.js";
import type { RespondCtx, ToolResult } from "@/discovery/ai/toolbox.js";
import { trimAmount } from "@/discovery/ai/toolbox.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";

/** Max items to read aloud in chat before pointing the user to the dashboard. */
const CHAT_PREVIEW_LIMIT = 4;

/**
 * The Basemate identity these dashboard reads key on. Matches the senderId used
 * across tx_confirmations, contacts, and embedded pay-mode (see app.router.ts),
 * and the userKey the portfolio/send paths already use.
 */
function senderKey(ctx: RespondCtx): string {
  return ctx.copyUserKey ?? ctx.inboxId;
}

function shortDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function amountLabel(amount: string | null, asset: string | null): string {
  if (!amount) return asset ?? "";
  return `${trimAmount(amount)}${asset ? ` ${asset}` : ""}`.trim();
}

export async function get_recent_activity(ctx: RespondCtx): Promise<ToolResult> {
  const user = senderKey(ctx);
  const link = appLink("activity");
  try {
    const rows = await TxConfirmationAdapter.listBySenderId(user, 100);
    if (rows.length === 0) {
      return {
        data: { count: 0 },
        control: {
          type: "text",
          text: `no transactions yet — once you send, swap, or add funds they'll show up here 👉 ${link}`,
        },
      };
    }
    const lines = rows.slice(0, CHAT_PREVIEW_LIMIT).map((r) => {
      const amt = amountLabel(r.transfer_amount, r.transfer_asset);
      const when = shortDate(r.created_at);
      const parts = [r.label ?? "transaction"];
      if (amt) parts.push(amt);
      const meta = [r.status, when].filter(Boolean).join(" · ");
      return `• ${parts.join(" — ")}${meta ? ` (${meta})` : ""}`;
    });
    const more =
      rows.length > CHAT_PREVIEW_LIMIT
        ? `\n\n+${rows.length - CHAT_PREVIEW_LIMIT} more — see it all 👉 ${link}`
        : `\n\nsee your full history 👉 ${link}`;
    return {
      data: { count: rows.length },
      control: {
        type: "text",
        text: `here's your recent activity 👇\n\n${lines.join("\n")}${more}`,
      },
    };
  } catch (err) {
    console.warn("⚠️ get_recent_activity failed:", err);
    return {
      data: { error: "activity lookup failed" },
      control: {
        type: "text",
        text: `couldn't pull your activity right now — try again in a sec, or check 👉 ${link}`,
      },
    };
  }
}

export async function get_recent_sends(ctx: RespondCtx): Promise<ToolResult> {
  const user = senderKey(ctx);
  const link = appLink("sends");
  try {
    // Person-to-person sends all carry a recipient_phone (direct + escrow).
    const txs = await TxConfirmationAdapter.listBySenderId(user, 200);
    const sends = txs.filter((t) => t.recipient_phone);
    if (sends.length === 0) {
      return {
        data: { count: 0 },
        control: {
          type: "text",
          text: `you haven't sent anyone money yet — send a friend some USDC and it'll show up here 👉 ${link}`,
        },
      };
    }
    const preview = sends.slice(0, CHAT_PREVIEW_LIMIT);
    const lines = await Promise.all(
      preview.map(async (t) => {
        const contact = t.recipient_phone
          ? await ContactsAdapter.findByPhone(user, t.recipient_phone).catch(() => null)
          : null;
        const who = contact?.name ?? t.recipient_phone ?? "recipient";
        const amt = amountLabel(t.transfer_amount, t.transfer_asset);
        const meta = [t.status, shortDate(t.created_at)].filter(Boolean).join(" · ");
        return `• ${who}${amt ? ` — ${amt}` : ""}${meta ? ` (${meta})` : ""}`;
      }),
    );
    const more =
      sends.length > CHAT_PREVIEW_LIMIT
        ? `\n\n+${sends.length - CHAT_PREVIEW_LIMIT} more — see them all 👉 ${link}`
        : `\n\nsee all your sends 👉 ${link}`;
    return {
      data: { count: sends.length },
      control: {
        type: "text",
        text: `here's who you've sent to lately 👇\n\n${lines.join("\n")}${more}`,
      },
    };
  } catch (err) {
    console.warn("⚠️ get_recent_sends failed:", err);
    return {
      data: { error: "sends lookup failed" },
      control: {
        type: "text",
        text: `couldn't pull your sends right now — try again in a sec, or check 👉 ${link}`,
      },
    };
  }
}

export async function set_payment_mode(
  ctx: RespondCtx,
  args: { mode: "automatic" | "manual" },
): Promise<ToolResult> {
  const user = senderKey(ctx);
  const link = appLink("settings");
  const target: "quick" | "manual" = args.mode === "automatic" ? "quick" : "manual";
  try {
    await WalletAdapter.setEmbeddedPayMode(user, target);
    const limit = (await WalletAdapter.getAutoSendLimit(user)) ?? DEFAULT_AUTO_SEND_LIMIT_USD;
    const text =
      target === "quick"
        ? `done ✅ you're on "Automatic" now — payments up to $${limit} send instantly, no tap. anything above that i'll still ask you to confirm.\n\nchange it anytime 👉 ${link}`
        : `done ✅ you're on "Confirm each" now — every payment waits for your tap before it sends.\n\nchange it anytime 👉 ${link}`;
    return { data: { payMode: target }, control: { type: "text", text } };
  } catch (err) {
    console.warn("⚠️ set_payment_mode failed:", err);
    return {
      data: { error: "set pay mode failed" },
      control: {
        type: "text",
        text: `couldn't change your payment setting right now — try again in a sec, or do it here 👉 ${link}`,
      },
    };
  }
}

export async function get_payment_mode(ctx: RespondCtx): Promise<ToolResult> {
  const user = senderKey(ctx);
  const link = appLink("settings");
  try {
    const [mode, limit] = await Promise.all([
      WalletAdapter.getEmbeddedPayMode(user),
      WalletAdapter.getAutoSendLimit(user),
    ]);
    const cap = limit ?? DEFAULT_AUTO_SEND_LIMIT_USD;
    const text =
      mode === "quick"
        ? `you're on "Automatic" — payments up to $${cap} send without a tap, and anything above that i'll still ask you to confirm.\n\nchange it anytime 👉 ${link}`
        : `you're on "Confirm each" — every payment waits for you to tap confirm before it sends.\n\nwant payments to go automatically? switch it 👉 ${link}`;
    return {
      data: { payMode: mode, autoSendLimitUsd: cap },
      control: { type: "text", text },
    };
  } catch (err) {
    console.warn("⚠️ get_payment_mode failed:", err);
    return {
      data: { error: "preferences lookup failed" },
      control: {
        type: "text",
        text: `couldn't read your payment settings right now — try again in a sec, or check 👉 ${link}`,
      },
    };
  }
}
