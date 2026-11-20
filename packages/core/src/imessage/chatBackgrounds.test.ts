import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  config: {
    env: "test",
    imessageBackgrounds: {
      address: "",
      token: "",
      tradingPath: "",
      moneyPath: "",
    },
  },
  readFile: vi.fn(),
  createClient: vi.fn(),
  chats: {
    create: vi.fn(),
    setBackground: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/config/config.js", () => ({
  config: mockState.config,
}));

vi.mock("@/utils/logger.js", () => ({
  logger: mockState.logger,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockState.readFile,
}));

vi.mock("@photon-ai/advanced-imessage", () => ({
  createClient: mockState.createClient,
}));

import {
  applyImessageChatBackground,
  resetImessageChatBackgroundStateForTests,
} from "./chatBackgrounds.js";

describe("applyImessageChatBackground", () => {
  beforeEach(() => {
    resetImessageChatBackgroundStateForTests();
    vi.clearAllMocks();
    mockState.config.imessageBackgrounds.address = "";
    mockState.config.imessageBackgrounds.token = "";
    mockState.config.imessageBackgrounds.tradingPath = "";
    mockState.config.imessageBackgrounds.moneyPath = "";
    mockState.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mockState.chats.create.mockResolvedValue({ chat: { guid: "any;-;+15555550123" } });
    mockState.chats.setBackground.mockResolvedValue(undefined);
    mockState.createClient.mockReturnValue({
      chats: mockState.chats,
      close: vi.fn(),
    });
  });

  it("disables safely when low-level Photon credentials are missing", async () => {
    mockState.config.imessageBackgrounds.tradingPath = "/assets/trading.png";

    await expect(
      applyImessageChatBackground({ senderId: "+15555550123", mode: "trading" }),
    ).resolves.toBe(false);

    expect(mockState.createClient).not.toHaveBeenCalled();
    expect(mockState.chats.setBackground).not.toHaveBeenCalled();
  });

  it("uses configured mode paths and skips repeat uploads for the same sender mode", async () => {
    mockState.config.imessageBackgrounds.address = "imessage.example.com:443";
    mockState.config.imessageBackgrounds.token = "token";
    mockState.config.imessageBackgrounds.tradingPath = "/assets/trading.png";
    mockState.config.imessageBackgrounds.moneyPath = "/assets/money.png";

    await expect(
      applyImessageChatBackground({ senderId: "+15555550123", mode: "trading" }),
    ).resolves.toBe(true);
    await expect(
      applyImessageChatBackground({ senderId: "+15555550123", mode: "trading" }),
    ).resolves.toBe(false);
    await expect(
      applyImessageChatBackground({ senderId: "+15555550123", mode: "money" }),
    ).resolves.toBe(true);

    expect(mockState.createClient).toHaveBeenCalledTimes(1);
    expect(mockState.readFile).toHaveBeenNthCalledWith(1, "/assets/trading.png");
    expect(mockState.readFile).toHaveBeenNthCalledWith(2, "/assets/money.png");
    expect(mockState.chats.create).toHaveBeenCalledTimes(2);
    expect(mockState.chats.create).toHaveBeenCalledWith(["+15555550123"]);
    expect(mockState.chats.setBackground).toHaveBeenCalledTimes(2);
    expect(mockState.chats.setBackground).toHaveBeenCalledWith(
      "any;-;+15555550123",
      new Uint8Array([1, 2, 3]),
    );
  });

  it("swallows SDK failures and does not cache failed attempts", async () => {
    mockState.config.imessageBackgrounds.address = "imessage.example.com:443";
    mockState.config.imessageBackgrounds.token = "token";
    mockState.config.imessageBackgrounds.moneyPath = "/assets/money.png";
    mockState.chats.setBackground
      .mockRejectedValueOnce(new Error("upstream failed"))
      .mockResolvedValueOnce(undefined);

    await expect(
      applyImessageChatBackground({ senderId: "+15555550123", mode: "money" }),
    ).resolves.toBe(false);
    await expect(
      applyImessageChatBackground({ senderId: "+15555550123", mode: "money" }),
    ).resolves.toBe(true);

    expect(mockState.chats.setBackground).toHaveBeenCalledTimes(2);
  });
});
