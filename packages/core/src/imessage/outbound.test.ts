import { afterEach, describe, expect, it } from "vitest";

import {
  confettiTextOutbound,
  formatOutboundForRepl,
  singleBubbleTextOutbound,
  transactionMiniAppOutbound,
  portfolioLinkOutbound,
  PORTFOLIO_VIEW_LINK_LABEL,
  sendImessageOutbound,
} from "./outbound.js";

const ORIGINAL_SECRET = process.env.PORTFOLIO_LINK_SECRET;

afterEach(() => {
  if (ORIGINAL_SECRET == null) delete process.env.PORTFOLIO_LINK_SECRET;
  else process.env.PORTFOLIO_LINK_SECRET = ORIGINAL_SECRET;
});

describe("iMessage portfolio outbound links", () => {
  it("builds a labeled portfolio link chunk", () => {
    process.env.PORTFOLIO_LINK_SECRET = "test-secret";

    const chunk = portfolioLinkOutbound("sender-1");

    expect(chunk.kind).toBe("portfolio_link");
    expect(chunk.label).toBe(PORTFOLIO_VIEW_LINK_LABEL);
    expect(chunk.url).toContain("user=sender-1&token=");
  });

  it("prints only the label in the local REPL", () => {
    process.env.PORTFOLIO_LINK_SECRET = "test-secret";
    expect(formatOutboundForRepl(portfolioLinkOutbound("sender-1"))).toBe(PORTFOLIO_VIEW_LINK_LABEL);
  });
});

describe("iMessage text links", () => {
  it("sends URL-only text as a rich link so Spectrum loads its metadata", async () => {
    const sent: unknown[] = [];

    await sendImessageOutbound(async (content) => {
      sent.push(content);
    }, "https://basemate.app/pay?s=test");

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe("https://basemate.app/pay?s=test");
    expect(sent[0]).toMatchObject({ build: expect.any(Function) });
  });

  it("separates surrounding copy from rich links", async () => {
    const sent: unknown[] = [];

    await sendImessageOutbound(async (content) => {
      sent.push(content);
    }, "tap to fund:\nhttps://basemate.app/pay?s=test\n(link expires soon)");

    expect(sent).toHaveLength(3);
    expect(sent[0]).toBe("tap to fund:");
    expect(sent[1]).toMatchObject({ build: expect.any(Function) });
    expect(sent[2]).toBe("(link expires soon)");
  });

  it("sends fund-style copy and URL in one bubble", async () => {
    const sent: unknown[] = [];
    const body =
      "tap to add $2 USDC via Apple Pay or Google Pay:\n\nhttps://basemate.app/pay?s=test\n\n(link expires in 10 minutes)";

    await sendImessageOutbound(async (content) => {
      sent.push(content);
    }, singleBubbleTextOutbound(body));

    expect(sent).toEqual([body]);
  });

  it("keeps messages without URLs as plain text", async () => {
    const sent: unknown[] = [];

    await sendImessageOutbound(async (content) => {
      sent.push(content);
    }, "your transfer is confirmed");

    expect(sent).toEqual(["your transfer is confirmed"]);
  });
});

describe("iMessage confetti outbound effects", () => {
  it("prints the inner text in the local REPL", () => {
    expect(formatOutboundForRepl(confettiTextOutbound("done — swap submitted."))).toBe(
      "done — swap submitted.",
    );
  });

  it("wraps confetti text before sending", async () => {
    const sent: unknown[] = [];

    await sendImessageOutbound(async (content) => {
      sent.push(content);
    }, confettiTextOutbound("done — swap submitted."));

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe("done — swap submitted.");
  });

  it("falls back to plain text when Spectrum reports an SMS-only recipient", async () => {
    const sent: unknown[] = [];
    const unsupported = Object.assign(new Error("effects require iMessage or RCS"), {
      grpcCode: 9,
    });

    await sendImessageOutbound(async (content) => {
      sent.push(content);
      if (sent.length === 1) throw unsupported;
    }, confettiTextOutbound("+919163504284 was sent 10 USDC"));

    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe("+919163504284 was sent 10 USDC");
  });

  it("does not hide transient or unknown effect failures", async () => {
    await expect(
      sendImessageOutbound(
        async () => {
          throw new Error("upstream unavailable");
        },
        confettiTextOutbound("done — swap submitted."),
      ),
    ).rejects.toThrow("upstream unavailable");
  });
});

describe("iMessage transaction mini-app outbound", () => {
  it("prints a direct sign link in the local REPL", () => {
    const chunk = transactionMiniAppOutbound({
      label: "Swap 10 USDC to ETH",
      url: "https://base.org/approve/mock-request",
      signerAddress: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
    });

    expect(formatOutboundForRepl(chunk)).toContain("https://base.org/approve/mock-request");
  });

  it("falls back to a rich direct link when mini-app metadata is missing", async () => {
    const sent: unknown[] = [];

    await sendImessageOutbound(async (content) => {
      sent.push(content);
    }, transactionMiniAppOutbound({
      label: "Swap 10 USDC to ETH",
      url: "https://base.org/approve/mock-request",
    }));

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe("Swap 10 USDC to ETH\ntap to review & confirm:");
    expect(sent[1]).toMatchObject({ build: expect.any(Function) });
  });

  it("wraps configured approvals as mini-app cards before sending", async () => {
    const sent: unknown[] = [];

    await sendImessageOutbound(async (content) => {
      sent.push(content);
    }, transactionMiniAppOutbound({
      label: "Swap 10 USDC to ETH",
      url: "https://base.org/approve/mock-request",
      signerAddress: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
      metadata: {
        appName: "Basemate",
        teamId: "ABCDE12345",
        extensionBundleId: "app.basemate.imessage",
      },
    }));

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe("Swap 10 USDC to ETH");
  });
});
