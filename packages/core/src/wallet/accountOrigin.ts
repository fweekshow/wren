/** Wallet connect and the signed-in account live on the apex host. */
export function basemateAccountOrigin(origin?: string): string {
  const raw = (origin || "https://basemate.app").replace(/\/$/, "");
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() === "app.basemate.app") {
      url.hostname = "basemate.app";
    }
    return url.origin;
  } catch {
    return "https://basemate.app";
  }
}
