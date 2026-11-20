import { StrategyAdapter, type StrategyRow } from "@/discovery/adapters/strategy.adapter.js";

import { buildStrategyFromPrompt } from "./promptStrategy.js";
import { PAPER_TRADING_OFF_MESSAGE } from "./liveTrading.js";

/**
 * Channel-neutral strategy authoring — the start of the shared `strategyApp`
 * seam. Builds a rails-clamped strategy from a free-form prompt and persists it
 * under any owner key (XMTP inbox or `tg:<userId>`), independent of XMTP
 * message contexts. Used by the Telegram controller today; the XMTP wizard keeps
 * its richer decision-chain UX and can migrate onto this later.
 */
export interface AuthoredStrategyResult {
  strategy: StrategyRow;
  explanation: string;
  assumptions: string[];
}

export type AuthorAndPaperDeployResult =
  | (AuthoredStrategyResult & { ok: true })
  | { ok: false; error: string };

export async function authorStrategy(input: {
  ownerKey: string;
  creatorWallet?: string | null;
  creatorBasename?: string | null;
  prompt: string;
  baseConfig?: import("@basemate/shared").StrategyConfig;
}): Promise<AuthoredStrategyResult | null> {
  const authored = await buildStrategyFromPrompt(
    input.prompt,
    input.baseConfig ? { baseConfig: input.baseConfig } : {},
  );
  const draft = await StrategyAdapter.createDraft({
    name: authored.name,
    creatorInboxId: input.ownerKey,
    creatorWallet: input.creatorWallet ?? null,
    creatorBasename: input.creatorBasename ?? null,
    prompt: input.prompt,
    config: authored.config,
  });
  if (!draft) return null;
  return { strategy: draft, explanation: authored.explanation, assumptions: authored.assumptions };
}

/** Paper trading is off — strategies are not authored or deployed. */
export async function authorAndPaperDeploy(_input: {
  ownerKey: string;
  creatorWallet?: string | null;
  prompt: string;
}): Promise<AuthorAndPaperDeployResult> {
  return { ok: false, error: PAPER_TRADING_OFF_MESSAGE };
}
