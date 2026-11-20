import { describe, expect, it } from "vitest";

import {
  confettiTextOutbound,
  portfolioLinkFromUrl,
  transactionMiniAppOutbound,
} from "@/imessage/outbound.js";

import { renderWhatsappOutbound } from "./outbound.js";

describe("renderWhatsappOutbound", () => {
  it("renders text and enables previews for links", () => {
    expect(renderWhatsappOutbound("see https://basemate.app")).toEqual([
      { text: "see https://basemate.app", previewUrl: true },
    ]);
  });

  it("renders text effects as plain WhatsApp text", () => {
    expect(renderWhatsappOutbound(confettiTextOutbound("done — swap submitted."))).toEqual([
      { text: "done — swap submitted." },
    ]);
  });

  it("renders portfolio links as label plus URL", () => {
    expect(renderWhatsappOutbound(portfolioLinkFromUrl("https://basemate.app/p/mock"))).toEqual([
      {
        text: "View more details\nhttps://basemate.app/p/mock",
        previewUrl: true,
      },
    ]);
  });

  it("renders transaction mini-app chunks as approval links", () => {
    const rendered = renderWhatsappOutbound(transactionMiniAppOutbound({
      label: "Swap 10 USDC to ETH",
      url: "https://app.basemate.app/approve/mock",
      signerAddress: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
    }));

    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.text).toContain("Swap 10 USDC to ETH");
    expect(rendered[0]?.text).toContain("https://app.basemate.app/approve/mock");
    expect(rendered[0]?.previewUrl).toBe(true);
  });
});
