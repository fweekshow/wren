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
  const m = /^\$(.+)$/.exec(card.amount);
  const bigAmount = m
    ? `<div class="amt"><span class="d">$</span><span class="n">${esc(m[1])}</span></div>`
    : `<div class="amt"><span class="n" style="font-size:56px">${esc(card.amount || card.stockName)}</span></div>`;
  const headline =
    card.state === "claimed"
      ? "Already claimed."
      : card.state === "returned"
        ? "This one went back."
        : card.state === "delivered"
          ? "It's in your Wren."
          : `${card.from ?? "Someone"} sent you a stock.`;
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=DM+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  body{margin:0;background:#fff;color:#0A0B0D;font-family:"Bricolage Grotesque",-apple-system,sans-serif}
  main{max-width:440px;margin:0 auto;padding:20px 16px 190px}
  .mark{width:34px;height:34px;border-radius:11px;background:#0050FA;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;margin:0 4px 12px}
  .hero{border-radius:32px;background:${bg};color:${ink};padding:22px;display:flex;flex-direction:column;gap:22px}
  .top{display:flex;justify-content:space-between;align-items:center}
  .who{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700}
  .face{width:40px;height:40px;border-radius:20px;background:#fff;color:#0A0B0D;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800}
  .tick{font:500 13px "DM Mono",monospace;color:${card.colors.soft}}
  .amt{display:flex;align-items:flex-start;letter-spacing:-.04em;line-height:1}
  .amt .d{font-size:34px;font-weight:700;margin-top:10px}
  .amt .n{font-size:88px;font-weight:800}
  .of{font-size:34px;font-weight:800;letter-spacing:-.03em;margin-top:2px}
  .hold{font-size:15px;opacity:.85}
  h1{font-size:34px;font-weight:800;letter-spacing:-.03em;line-height:1.05;margin:24px 8px 0}
  p{font-size:16px;line-height:1.4;color:#5B616E;margin:12px 8px 0}
  .pin{position:fixed;left:0;right:0;bottom:0;background:#fff;padding:14px 20px 34px;display:flex;flex-direction:column;gap:10px;max-width:440px;margin:0 auto}
  a.btn{height:60px;border-radius:999px;display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:18px;font-weight:700}
  a.primary{background:#0000FF;color:#fff}
  a.secondary{background:#EEF0F3;color:#0A0B0D}
</style>
</head><body><main>
  <div class="mark" aria-hidden="true">W</div>
  <div class="hero">
    <div class="top">
      <div class="who"><span class="face">${esc((card.from ?? "W").slice(0, 1).toUpperCase())}</span>${esc(card.from ? `from ${card.from}` : "for you")}</div>
      <span class="tick">${esc(card.ticker)}</span>
    </div>
    <div>${bigAmount}<div class="of">of ${esc(card.stockName)}</div></div>
    <div class="hold">${esc(line)}</div>
  </div>
  <h1>${esc(headline)}</h1>
  ${open && card.state !== "delivered" ? `<p>Sign in to Wren with this phone number and it lands in your account. No fees to claim it.</p>` : ""}
  ${open ? `<div class="pin"><a class="btn primary" href="${esc(args.appUrl)}">Open in Wren</a>${args.downloadUrl ? `<a class="btn secondary" href="${esc(args.downloadUrl)}">Get Wren</a>` : ""}</div>` : ""}
</main></body></html>`;
}
