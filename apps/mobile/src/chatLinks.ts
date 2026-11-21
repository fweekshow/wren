// Links that open a chat already addressed and filled in.
// iOS Messages: sms:<number>&body=…  ·  WhatsApp: https://wa.me/<digits>?text=…

const digitsOf = (phone: string) => phone.replace(/[^\d]/g, '');

export function messagesUrl(phone: string, body: string): string {
  return `sms:${digitsOf(phone)}&body=${encodeURIComponent(body)}`;
}

export function whatsappUrl(phone: string, body: string): string {
  return `https://wa.me/${digitsOf(phone)}?text=${encodeURIComponent(body)}`;
}
