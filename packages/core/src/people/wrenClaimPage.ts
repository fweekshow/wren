// The claim card as a 1200×630 PNG (what iMessage and WhatsApp unfurl) and
// the /c/<code> page around it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

import { cardLine, cardTitle, type ClaimCard } from "@/people/wrenClaim.js";

const fontDir = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));
let fonts: { name: string; data: Buffer; weight: 500 | 800; style: "normal" }[] | null = null;
function loadFonts() {
  fonts ??= [
    { name: "Bricolage", data: readFileSync(`${fontDir}BricolageGrotesque_800ExtraBold.ttf`), weight: 800, style: "normal" },
    { name: "Bricolage", data: readFileSync(`${fontDir}BricolageGrotesque_500Medium.ttf`), weight: 500, style: "normal" },
  ];
  return fonts;
}

type Node = { type: string; props: Record<string, unknown> & { children?: unknown } };
const el = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
  type,
  props: { style, children },
});

const pngCache = new Map<string, Buffer>();

/** Render the card. Cached by its content, so a state change makes a new image. */
export async function cardPng(card: ClaimCard): Promise<Buffer> {
  const key = JSON.stringify([card.from, card.amount, card.stockName, card.ticker, card.state, card.colors.bg]);
  const hit = pngCache.get(key);
  if (hit) return hit;

  const { bg, ink, soft } = card.colors;
  const big = card.amount ? `${card.amount} of ${card.stockName}` : card.stockName;
  const from = card.from ? `from ${card.from}` : "for you";
  const tree = el(
    "div",
    {
      width: 1200,
      height: 630,
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: 72,
      background: bg,
      color: ink,
      fontFamily: "Bricolage",
    },
    [
      el("div", { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 40, fontWeight: 800 }, [
        el("div", { display: "flex" }, "Wren"),
        el("div", { display: "flex", fontSize: 34, fontWeight: 500, color: soft }, card.ticker),
      ]),
      el("div", { display: "flex", flexDirection: "column" }, [
        el("div", { display: "flex", fontSize: 44, fontWeight: 500, color: soft }, from),
        el(
          "div",
          { display: "flex", fontSize: big.length > 18 ? 96 : 124, fontWeight: 800, letterSpacing: -4, lineHeight: 1.02, marginTop: 8 },
          big,
        ),
      ]),
      el(
        "div",
        {
          display: "flex",
          alignSelf: "flex-start",
          background: ink,
          color: bg,
          borderRadius: 999,
          padding: "18px 34px",
          fontSize: 36,
          fontWeight: 800,
        },
        card.state === "claimed"
          ? "Claimed"
          : card.state === "returned"
            ? "Sent back"
            : card.state === "delivered"
              ? "In your Wren"
              : "Tap to claim",
      ),
    ],
  );

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], { width: 1200, height: 630, fonts: loadFonts() });
  const png = Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
  if (pngCache.size > 500) pngCache.delete(pngCache.keys().next().value as string);
  pngCache.set(key, png);
  return png;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The /c/<code> page: Open Graph tags for the unfurl, the card, and the way into the app. */
export function claimPageHtml(args: {
  card: ClaimCard;
  pageUrl: string;
  imageUrl: string;
  appUrl: string;
  downloadUrl: string | null;
}): string {
  const { card } = args;
  const title = cardTitle(card);
  const line = cardLine(card);
  const open = card.state === "waiting" || card.state === "sending" || card.state === "delivered";
  const { bg, ink } = card.colors;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(line)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Wren">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(line)}">
<meta property="og:url" content="${esc(args.pageUrl)}">
<meta property="og:image" content="${esc(args.imageUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(line)}">
<meta name="twitter:image" content="${esc(args.imageUrl)}">
<meta name="robots" content="noindex">
<style>
  body{margin:0;background:#fff;color:#0A0B0D;font-family:-apple-system,"Helvetica Neue",sans-serif}
  main{max-width:440px;margin:0 auto;padding:40px 24px}
  .card{border-radius:28px;overflow:hidden;background:${bg}}
  .card img{display:block;width:100%;height:auto}
  h1{font-size:30px;line-height:1.1;letter-spacing:-0.02em;margin:28px 0 8px}
  p{font-size:17px;color:#5B616E;margin:0 0 28px}
  a.btn{display:block;text-align:center;text-decoration:none;font-weight:700;font-size:18px;border-radius:999px;padding:18px;margin-top:10px}
  a.primary{background:#0000FF;color:#fff}
  a.secondary{background:#EEF0F3;color:#0A0B0D}
  small{display:block;color:#717886;font-size:13px;margin-top:20px;line-height:1.4}
</style>
</head><body><main>
  <div class="card" style="color:${ink}"><img src="${esc(args.imageUrl)}" alt="${esc(title)}"></div>
  <h1>${esc(title)}</h1>
  <p>${esc(line)}</p>
  ${open ? `<a class="btn primary" href="${esc(args.appUrl)}">Open in Wren</a>` : ""}
  ${open && args.downloadUrl ? `<a class="btn secondary" href="${esc(args.downloadUrl)}">Get Wren</a>` : ""}
  ${open && card.state !== "delivered" ? `<small>Sign in to Wren with the phone number this was sent to, and it lands in your account.</small>` : ""}
</main></body></html>`;
}
