import { describe, expect, it } from "vitest";

import {
  isPrivateTelegramChat,
  isVibeTradingCommand,
  normalizeGroupMessageText,
  shouldRespondInGroup,
} from "./groupGate.js";

const bot = { id: 8833721402, username: "basemate_bot" };

describe("groupGate", () => {
  it("detects vibe commands with optional @bot suffix", () => {
    expect(isVibeTradingCommand("/start")).toBe(true);
    expect(isVibeTradingCommand("/vibe@basemate_bot")).toBe(true);
    expect(isVibeTradingCommand("/help")).toBe(false);
  });

  it("responds in groups for commands, mentions, and replies to the bot", () => {
    expect(shouldRespondInGroup({ text: "/start" }, bot)).toBe(true);
    expect(
      shouldRespondInGroup(
        {
          text: "@basemate_bot build a btc short",
          entities: [{ type: "mention", offset: 0, length: 13 }],
        },
        bot,
      ),
    ).toBe(true);
    expect(
      shouldRespondInGroup(
        { text: "30x btc short", reply_to_message: { from: { id: bot.id, is_bot: true } } },
        bot,
      ),
    ).toBe(true);
    expect(shouldRespondInGroup({ text: "random group chatter" }, bot)).toBe(false);
  });

  it("strips mentions and command prefixes from group prompts", () => {
    const text = normalizeGroupMessageText(
      "@basemate_bot 30x btc short",
      [{ type: "mention", offset: 0, length: 13 }],
      bot,
    );
    expect(text).toBe("30x btc short");
    expect(normalizeGroupMessageText("/vibe@basemate_bot", undefined, bot)).toBe("");
  });

  it("treats private chats separately from groups", () => {
    expect(isPrivateTelegramChat("private")).toBe(true);
    expect(isPrivateTelegramChat("supergroup")).toBe(false);
  });
});
