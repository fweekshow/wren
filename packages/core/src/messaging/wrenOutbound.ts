import { createClient, template, text } from "@photon-ai/whatsapp-business";

import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";
import { outboundChannel } from "@/messaging/wrenAccount.js";
import { listPushTokens } from "@/messaging/wrenAccount.js";

export async function sendPush(senderId: string, title: string, body: string): Promise<void> {
  const tokens = await listPushTokens(senderId);
  if (tokens.length === 0) return;
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      tokens.map((to) => ({
        to,
        title,
        body,
        sound: "default",
      })),
    ),
  }).catch((err) => {
    logger.warn({ err }, "[wren] push failed");
  });
}

export async function sendWhatsappNotice(args: {
  phone: string;
  message: string;
  templateVars?: { senderName: string; amountUsd: string; symbol: string; giftId: string };
}): Promise<void> {
  if (!config.whatsapp.accessToken || !config.whatsapp.phoneNumberId) {
    throw new Error("WhatsApp is not configured.");
  }
  const client = createClient({
    accessToken: config.whatsapp.accessToken,
    phoneNumberId: config.whatsapp.phoneNumberId,
    appSecret: config.whatsapp.appSecret,
  });
  const channel = await outboundChannel(args.phone);
  if (channel === "template" && args.templateVars) {
    const vars = args.templateVars;
    await client.messages.send({
      to: args.phone.replace(/^\+/, ""),
      template: template("wren_stock_gift_claim", "en_US")
        .body(text(vars.senderName), text(vars.amountUsd), text(vars.symbol))
        .urlButton(0, text(vars.giftId)),
    });
    return;
  }
  await client.messages.send({
    to: args.phone.replace(/^\+/, ""),
    text: { body: args.message, previewUrl: args.message.includes("https://") },
  });
}

export async function routeRecipientNotice(args: {
  phone: string;
  message: string;
  sendImessage: (phone: string, message: string) => Promise<void>;
  templateVars?: { senderName: string; amountUsd: string; symbol: string; giftId: string };
}): Promise<"whatsapp" | "imessage" | "template"> {
  const channel = await outboundChannel(args.phone);
  if (channel === "imessage") {
    await args.sendImessage(args.phone, args.message);
    return channel;
  }
  try {
    await sendWhatsappNotice({
      phone: args.phone,
      message: args.message,
      templateVars: channel === "template" ? args.templateVars : undefined,
    });
    return channel;
  } catch (err) {
    logger.warn({ err }, "[wren] whatsapp notice failed, falling back");
    await args.sendImessage(args.phone, args.message);
    return "imessage";
  }
}
