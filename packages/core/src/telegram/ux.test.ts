import { describe, expect, it } from "vitest";

import {
  CALLBACK_FAILURE_COPY,
  goLiveConfirmView,
  homeLinkedView,
  homeUnlinkedView,
  myStrategiesView,
  pnlLabel,
  remixPreviewView,
  strategyCardView,
  truncate,
  walletView,
  type StrategyCardVM,
  type StrategyListItemVM,
} from "./ux.js";

function card(overrides: Partial<StrategyCardVM> = {}): StrategyCardVM {
  return {
    strategyId: "s1",
    name: "Momentum ETH",
    mode: "paper",
    version: 1,
    pairs: ["ETH-USD"],
    direction: "long",
    marginUsdc: 30,
    leverage: 5,
    tpPercent: 1,
    slPercent: 0.5,
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    pnlUsd: 4.5,
    pnlState: "paper",
    modes: [
      { label: "Alpha Crush", blurb: "crisis/dislocation event playbook", live: true },
      { label: "Superburst", blurb: "rides sharp velocity bursts", live: true },
    ],
    antiChop: true,
    alphaCrush: true,
    ...overrides,
  };
}

describe("pnlLabel", () => {
  it("never conflates modeled paper with settled live", () => {
    expect(pnlLabel("paper", 4.5)).toMatch(/modeled PnL \(est\.\)/);
    expect(pnlLabel("live_open", 4.5)).toMatch(/unrealized \(mark\)/);
    expect(pnlLabel("live_closed_pending", 4.5)).toMatch(/settling on-chain/);
    expect(pnlLabel("live_closed_final", 4.5)).toMatch(/settled PnL/);
  });
  it("marks demo size for paper default bumps", () => {
    expect(pnlLabel("paper", 1, { demoSize: true })).toMatch(/demo size/);
  });
  it("formats negatives", () => {
    expect(pnlLabel("live_closed_final", -3.2)).toContain("-$3.20");
  });
});

describe("home views", () => {
  it("tells unlinked users paper trading is off", () => {
    const v = homeUnlinkedView();
    expect(v.text).toMatch(/paper trading and automated strategies are off/i);
    expect(v.keyboard).toEqual([]);
  });
  it("tells linked users paper trading is off and only offers the wallet", () => {
    const v = homeLinkedView();
    expect(v.text).toMatch(/paper trading and automated strategies are off/i);
    expect(v.keyboard[0]!.map((b) => b.action?.action)).toEqual(["wallet"]);
  });
  it("stays off when the old kill switch flag is set", () => {
    expect(homeLinkedView({ killSwitchOn: true }).text).toMatch(/off/i);
  });
});

describe("myStrategiesView", () => {
  it("orders live before paper and lists both in the body", () => {
    const items: StrategyListItemVM[] = [
      { strategyId: "p", name: "Paper one", mode: "paper", pnlUsd: 1, pnlState: "paper" },
      { strategyId: "l", name: "Live one", mode: "live", pnlUsd: 2, pnlState: "live_open" },
    ];
    const v = myStrategiesView(items);
    expect(v.text).toMatch(/<b>Live<\/b>/);
    expect(v.text).toMatch(/<b>Paper<\/b>/);
    expect(v.text).toMatch(/Live one/);
    expect(v.keyboard[0]![0]!.action?.strategyId).toBe("l");
    expect(v.keyboard[1]![0]!.action?.strategyId).toBe("p");
    expect(v.keyboard[0]![0]!.text).toMatch(/^LIVE ·/);
    expect(v.keyboard[1]![0]!.text).toMatch(/^paper ·/);
    const nav = v.keyboard.flat().map((b) => b.action?.action);
    expect(nav).toContain("home");
  });
  it("shows an empty state with Home", () => {
    const v = myStrategiesView([]);
    expect(v.text).toMatch(/None yet/i);
    expect(v.keyboard.flat().map((b) => b.action?.action)).toContain("home");
  });
  it("escapes HTML in strategy names", () => {
    const v = myStrategiesView([
      { strategyId: "x", name: "a <b>hack", mode: "paper", pnlUsd: 0, pnlState: "paper" },
    ]);
    expect(v.text).toContain("a &lt;b&gt;hack");
    expect(v.text).not.toContain("a <b>hack");
  });
});

describe("strategyCardView", () => {
  it("paper card offers Go Live (confirm), not a skip-paper execute", () => {
    const v = strategyCardView(card({ mode: "paper" }));
    const actions = v.keyboard.flat().map((b) => b.action?.action);
    expect(actions).toContain("go_live_confirm");
    expect(actions).not.toContain("execute");
  });
  it("hides Go Live when live trading is paused", () => {
    const v = strategyCardView(card({ mode: "paper" }), { livePaused: true });
    const actions = v.keyboard.flat().map((b) => b.action?.action);
    expect(actions).not.toContain("go_live_confirm");
  });
  it("live card has no Go Live", () => {
    const v = strategyCardView(card({ mode: "live", pnlState: "live_open" }));
    const actions = v.keyboard.flat().map((b) => b.action?.action);
    expect(actions).not.toContain("go_live_confirm");
  });
  it("labels TP/SL as ROI on margin", () => {
    const text = strategyCardView(card()).text;
    expect(text).toMatch(/on margin/);
    expect(text).toMatch(/TP \+5%/);
    expect(text).toMatch(/SL -2\.5%/);
    expect(text).not.toMatch(/price move/);
  });

  it("includes Modify, Remix, and Technicals actions", () => {
    const actions = strategyCardView(card()).keyboard.flat().map((b) => b.action?.action);
    expect(actions).toContain("modify");
    expect(actions).toContain("remix");
    expect(actions).toContain("technicals");
  });

  it("bullets the config block and mode badge sits on the title line", () => {
    const text = strategyCardView(card()).text;
    expect(text).toMatch(/<b>Momentum ETH<\/b> · PAPER/);
    expect(text).toMatch(/• .*margin · 5x/);
    expect(text).toMatch(/• <b>Alpha Crush<\/b> —/);
  });

  it("names the actual Tactical Alpha playbook it runs", () => {
    const text = strategyCardView(card()).text;
    expect(text).toMatch(/Playbook/);
    expect(text).toMatch(/Alpha Crush/);
    expect(text).toMatch(/crisis\/dislocation event playbook/);
    expect(text).toMatch(/Guards:/);
  });

  it("flags not-yet-live modes as coming soon", () => {
    const text = strategyCardView(
      card({ modes: [{ label: "Orderbook Impulse", blurb: "microstructure scalps", live: false }] }),
    ).text;
    expect(text).toMatch(/coming soon/);
  });
});

describe("remixPreviewView", () => {
  it("shows the diagnosis and Apply/Keep buttons", () => {
    const v = remixPreviewView(card(), "trend_pullback hit SL 6/8 times — tightened entries");
    expect(v.text).toMatch(/Proposed tweak/);
    expect(v.text).toMatch(/trend_pullback hit SL/);
    const actions = v.keyboard.flat().map((b) => b.action?.action);
    expect(actions).toEqual(["remix_apply", "open_detail"]);
  });
});

describe("goLiveConfirmView", () => {
  it("discloses real USDC, the 10% fee, and the TP/SL non-guarantee", () => {
    const v = goLiveConfirmView(card());
    expect(v.text).toMatch(/real USDC/i);
    expect(v.text).toMatch(/10% of new profits/i);
    expect(v.text).toMatch(/fill worse/i);
    expect(v.text).toMatch(/on margin/);
    expect(v.text).toMatch(/<b>Before you confirm<\/b>/);
    expect(v.text).toMatch(/• This uses real USDC/);
    const actions = v.keyboard.flat().map((b) => b.action?.action);
    expect(actions).toEqual(["go_live", "open_detail"]);
  });
});

describe("walletView", () => {
  it("shows USDC-only balance, gas-covered copy, and Add Funds when a fund url exists", () => {
    const v = walletView({
      walletAddress: "0x7284221CEc9738549df818157e77613b3cf64714",
      balances: [{ symbol: "USDC", formatted: "25.5" }],
      fundUrl: "https://basemate.app/pay?s=abc123",
    });
    expect(v.text).toMatch(/fully automatically/i);
    expect(v.text).toMatch(/Live/);
    expect(v.text).toMatch(/\$25\.50/);
    expect(v.text).toMatch(/USDC only/i);
    expect(v.text).toMatch(/gas is covered/i);
    expect(v.text).not.toMatch(/ETH ·/);
    expect(v.text).toContain("0x7284221CEc9738549df818157e77613b3cf64714");
    expect(v.keyboard[0]![0]!.url).toBe("https://basemate.app/pay?s=abc123");
  });
});

describe("copy + helpers", () => {
  it("has failure copy for every callback reason", () => {
    for (const key of ["not_found", "expired", "wrong_user", "wrong_chat", "already_used", "group_only"]) {
      expect(CALLBACK_FAILURE_COPY[key]).toBeTruthy();
    }
  });
  it("truncate keeps labels short", () => {
    expect(truncate("abcdefghijklmnop", 8)).toHaveLength(8);
  });
});
