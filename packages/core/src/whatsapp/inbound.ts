export type WhatsappInboundContent = {
  type: string;
  body?: string;
  interactive?: {
    type?: string;
    reply?: {
      id?: string;
      title?: string;
      description?: string;
      responseJson?: string;
    };
  };
  button?: {
    text?: string;
    payload?: string;
  };
  contacts?: Array<{
    name?: { formattedName?: string; firstName?: string; lastName?: string };
    phones?: Array<{ phone?: string }>;
  }>;
};

export type NormalizedWhatsappInbound =
  | { kind: "text"; text: string }
  | { kind: "contact"; name?: string; phone?: string }
  | { kind: "unsupported"; reply: string };

function firstContact(content: WhatsappInboundContent): NormalizedWhatsappInbound | null {
  const contact = content.contacts?.[0];
  if (!contact) return null;
  const name =
    contact.name?.formattedName ||
    [contact.name?.firstName, contact.name?.lastName].filter(Boolean).join(" ") ||
    undefined;
  const phone = contact.phones?.find((item) => item.phone)?.phone;
  if (!name && !phone) return null;
  return { kind: "contact", name, phone };
}

export function normalizeWhatsappInbound(
  content: WhatsappInboundContent,
): NormalizedWhatsappInbound {
  switch (content.type) {
    case "text": {
      const text = content.body?.trim() ?? "";
      return text
        ? { kind: "text", text }
        : { kind: "unsupported", reply: "send me a text message and i'll help from there." };
    }
    case "interactive": {
      const reply = content.interactive?.reply;
      const text = reply?.title || reply?.id || reply?.responseJson || "";
      return text.trim()
        ? { kind: "text", text: text.trim() }
        : { kind: "unsupported", reply: "i couldn't read that button reply — type your choice instead." };
    }
    case "button": {
      const text = content.button?.text || content.button?.payload || "";
      return text.trim()
        ? { kind: "text", text: text.trim() }
        : { kind: "unsupported", reply: "i couldn't read that button reply — type your choice instead." };
    }
    case "contacts":
      return firstContact(content) ?? {
        kind: "unsupported",
        reply: "i couldn't read that contact card — send the phone number as text instead.",
      };
    default:
      return {
        kind: "unsupported",
        reply: "i can handle text on WhatsApp right now — send your request as a message.",
      };
  }
}
