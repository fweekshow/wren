import type { MessageContext } from "@xmtp/agent-sdk";

import { AVANTIS_DISABLED_MSG } from "@/discovery/ai.js";
import { isLaunchpadMode } from "@/discovery/launchpadMode.js";
import { isStrategyLiveTradingPaused } from "@/discovery/strategy/liveTrading.js";
import type { ActionHandler, AppConfig } from "@/xmtp/content-types/inline-actions/index.js";

export type CapabilitiesMenuHandlers = {
  startPromptStrategy: (ctx: MessageContext) => Promise<void>;
  listOpenStrategies: (ctx: MessageContext) => Promise<void>;
  listOpenPositions: (ctx: MessageContext) => Promise<void>;
  showWalletBalance: (ctx: MessageContext) => Promise<void>;
  startSayLess: (ctx: MessageContext) => Promise<void>;
  startLaunchWizard: (ctx: MessageContext) => Promise<void>;
  showNewPairs: (ctx: MessageContext) => Promise<void>;
  showCheckTokenHelp: (ctx: MessageContext) => Promise<void>;
  showTrendingTokens: (ctx: MessageContext) => Promise<void>;
  startYieldCompare: (ctx: MessageContext) => Promise<void>;
};

const BACK = { id: "main-menu", label: "← Back", style: "secondary" as const };

export function createCapabilitiesConfig(
  handlers: CapabilitiesMenuHandlers,
  avantisEnabled: boolean,
): AppConfig {
  const h = (fn: (ctx: MessageContext) => Promise<void>): ActionHandler =>
    fn as ActionHandler;
  const liveTradingPaused = isStrategyLiveTradingPaused();

  const menuPerps = avantisEnabled
    ? {
        id: "menu_perps",
        dmOnly: true,
        title: "Perps — review or close open positions. Paper trading and automated strategies are off.",
        actions: [
          {
            id: "cap_perp_open_positions",
            label: liveTradingPaused ? "Live Positions (close only)" : "Live Positions",
            style: "primary" as const,
            handler: h(handlers.listOpenPositions),
          },
          {
            id: "cap_perp_wallet_balance",
            label: "Basemate Wallet",
            style: "primary" as const,
            handler: h(handlers.showWalletBalance),
          },
          BACK,
        ],
      }
    : {
        id: "menu_perps",
        dmOnly: true,
        title: AVANTIS_DISABLED_MSG,
        actions: [BACK],
      };

  const sayLessAction = avantisEnabled
  && !liveTradingPaused
    ? [
        {
          id: "cap_say_less",
          label: "Say Less",
          style: "primary" as const,
          handler: h(handlers.startSayLess),
        },
      ]
    : [];

  if (isLaunchpadMode()) {
    return {
      name: "Basemate",
      options: { autoShowMenuAfterAction: false },
      menus: {
        "main-menu": {
          id: "main-menu",
          title:
            "i'm basemate — the Base App launcher for B20 tokens paired with Coinbase stocks. pick one:",
          actions: [
            {
              id: "cap_launch",
              label: "Launch",
              style: "primary",
              handler: h(handlers.startLaunchWizard),
            },
            {
              id: "cap_new_pairs",
              label: "New Pairs",
              style: "primary",
              handler: h(handlers.showNewPairs),
            },
          ],
        },
      },
    };
  }

  return {
    name: "Basemate",
    options: { autoShowMenuAfterAction: false },
    menus: {
      "main-menu": {
        id: "main-menu",
        title:
          "i'm basemate — perps, earn, launch, and analysis on Base. pick what you want to do:",
        actions: [
          { id: "menu_perps", label: "Perps", style: "primary", dmOnly: true },
          { id: "menu_earn", label: "Earn", style: "primary" },
          { id: "menu_launch", label: "Launch", style: "primary" },
          { id: "menu_market", label: "Analysis", style: "primary" },
          ...sayLessAction,
        ],
      },
      menu_market: {
        id: "menu_market",
        title: "Analysis — look up tokens or see what's trending on Base",
        actions: [
          {
            id: "cap_check_token",
            label: "Check a token",
            style: "primary" as const,
            handler: h(handlers.showCheckTokenHelp),
          },
          {
            id: "cap_trending",
            label: "Trending",
            style: "primary" as const,
            handler: h(handlers.showTrendingTokens),
          },
          BACK,
        ],
      },
      menu_perps: menuPerps,
      menu_earn: {
        id: "menu_earn",
        title: "Earn — compare yield across Moonwell, Morpho, and Aave on Base",
        actions: [
          {
            id: "cap_yield_compare",
            label: "Compare yield",
            style: "primary" as const,
            handler: h(handlers.startYieldCompare),
          },
          BACK,
        ],
      },
      menu_launch: {
        id: "menu_launch",
        title: "Launch — create a B20 token paired with a Coinbase stock on Base",
        actions: [
          {
            id: "cap_launch",
            label: "Launch a token",
            style: "primary" as const,
            handler: h(handlers.startLaunchWizard),
          },
          {
            id: "cap_new_pairs",
            label: "New Pairs",
            style: "primary" as const,
            handler: h(handlers.showNewPairs),
          },
          BACK,
        ],
      },
    },
  };
}
