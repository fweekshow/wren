import { describe, expect, it, vi } from "vitest";

import {
  isImessageMentioned,
  isReplyToOwnImessage,
  removeImessageMention,
} from "./groupEngagement.js";

describe("iMessage group engagement", () => {
  it.each(["Basemate help", "basemate help", "@basemate help", "@Basemate help"])(
    "recognizes %s as a mention",
    (text) => {
      expect(isImessageMentioned(text)).toBe(true);
      expect(removeImessageMention(text)).toBe("help");
    },
  );

  it("does not match basemate inside another word", () => {
    expect(isImessageMentioned("the basematerial changed")).toBe(false);
  });

  it("recognizes the name after punctuation", () => {
    expect(isImessageMentioned("hey, Basemate can you help?")).toBe(true);
  });

  it.each(["buy BASEMATE", "buy $BASEMATE", "swap 10 USDC to BASEMATE"])(
    "does not treat the BASEMATE token in %s as a mention",
    (text) => {
      expect(isImessageMentioned(text)).toBe(false);
      expect(removeImessageMention(text)).toBe(text);
    },
  );

  it("removes only the bot handle and preserves the BASEMATE asset", () => {
    expect(removeImessageMention("@basemate buy $BASEMATE")).toBe("buy $BASEMATE");
    expect(removeImessageMention("@basemate.base.eth buy BASEMATE")).toBe("buy BASEMATE");
    expect(removeImessageMention("Basemate buy BASEMATE")).toBe("buy BASEMATE");
  });

  it("accepts a reply whose target was sent by the bot", async () => {
    const getMessage = vi.fn(async (id: string) => {
      if (id === "inbound") return { isFromMe: false, replyTargetGuid: "bot-message" };
      return { isFromMe: id === "bot-message" };
    });

    await expect(isReplyToOwnImessage("inbound", getMessage)).resolves.toBe(true);
    expect(getMessage).toHaveBeenCalledWith("bot-message");
  });

  it("rejects ordinary messages and replies to other participants", async () => {
    const ordinary = vi.fn(async () => ({ isFromMe: false }));
    await expect(isReplyToOwnImessage("ordinary", ordinary)).resolves.toBe(false);
    expect(ordinary).toHaveBeenCalledTimes(1);

    const participantReply = vi.fn(async (id: string) => ({
      isFromMe: false,
      ...(id === "inbound" ? { replyTargetGuid: "participant-message" } : {}),
    }));
    await expect(isReplyToOwnImessage("inbound", participantReply)).resolves.toBe(false);
  });
});
