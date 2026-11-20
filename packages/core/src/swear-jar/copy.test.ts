import { describe, expect, it } from "vitest";

import {
  jarName,
  copyCatchFunded,
  copyCatchOptedOut,
  copyHelp,
  copyNahEmpty,
  copyOptInReady,
  copySecrets,
  copySettle,
  copySettleConfirm,
  copyStandings,
} from "./copy.js";
import { biggestSinner, pickWinner, type StandingsRow } from "./store.js";

describe("jarName", () => {
  it("uses first name lowercased", () => {
    expect(jarName("Dad Smith")).toBe("dad");
    expect(jarName("Emma")).toBe("emma");
  });
  it("masks phones and emails", () => {
    expect(jarName("+15551234567")).toBe("you");
    expect(jarName("dad@icloud.com")).toBe("you");
    expect(jarName(null)).toBe("you");
  });
});

describe("copy", () => {
  it("formats a catch line", () => {
    expect(copyCatchFunded("dad", 1)).toBe("a fine curse, dad. $1 into the jar. i'm at $1.");
  });
  it("leads standings with pot and who would win", () => {
    const standings: StandingsRow[] = [
      { senderId: "1", name: "Dad", swearCount: 2, unpaidCount: 0, eligible: true },
      { senderId: "2", name: "Emma", swearCount: 0, unpaidCount: 0, eligible: true },
      { senderId: "3", name: "Mom", swearCount: 1, unpaidCount: 0, eligible: true },
    ];
    const text = copyStandings(standings, 3);
    expect(text).toContain("the jar holds $3.");
    expect(text).toContain("emma leads — cleanest mouth. they'd take it.");
    expect(text).toContain("dad put $2 in (2 swears).");
    expect(text).toContain("mom put $1 in (1 swear).");
  });
  it("marks unpaid swears on the board", () => {
    const text = copyStandings(
      [{ senderId: "1", name: "Dad", swearCount: 2, unpaidCount: 2, eligible: true }],
      0,
    );
    expect(text).toContain("dad: 2 swears ($2 unpaid — not in the pool yet).");
  });
  it("empty pot is plain", () => {
    const text = copyStandings(
      [{ senderId: "1", name: "Emma", swearCount: 0, unpaidCount: 0, eligible: true }],
      0,
    );
    expect(text).toContain("the jar is empty — $0.");
    expect(text).toContain("emma leads");
  });
  it("help lists settle and pot while armed", () => {
    const text = copyHelp(true);
    expect(text).toContain("the dollar enters thy pot");
    expect(text).toContain("alexander settle");
    expect(text).toContain("what's in the pot");
    expect(text).toContain("nah");
    expect(text).toContain("count me in");
    expect(text).toContain("don't charge me");
    expect(text).toContain("new round");
    expect(text).toContain("i hold my secrets");
  });
  it("secrets copy is jar-warrior, not a word list", () => {
    const text = copySecrets();
    expect(text.toLowerCase()).toContain("i hold my secrets");
    expect(text.toLowerCase()).not.toContain("fuck");
    expect(text.toLowerCase()).not.toContain("regex");
  });
  it("settle copy restarts the round", () => {
    expect(copySettle({ potUsd: 3, winnerName: "emma", sinnerName: "dad" })).toContain(
      "new round",
    );
    expect(copySettleConfirm(3, "emma")).toContain("alexander settle");
    expect(copyNahEmpty()).toBe("nothing to return.");
    expect(copyOptInReady()).toContain("on my tab");
  });
  it("opted-out catch still counts and bugs them into the pool", () => {
    const text = copyCatchOptedOut("dad", "https://example.com/setup");
    expect(text).toContain("counted");
    expect(text).toContain("are you broke, fine sir?");
    expect(text).toContain("count me in");
    expect(text).toContain("https://example.com/setup");
  });
  it("help before summon points at alexander on", () => {
    expect(copyHelp(false)).toContain("@basemate alexander on");
  });
});

describe("winner rules", () => {
  it("picks fewest swears among eligible", () => {
    const standings: StandingsRow[] = [
      { senderId: "dad", name: "Dad", swearCount: 2, unpaidCount: 0, eligible: true },
      { senderId: "emma", name: "Emma", swearCount: 0, unpaidCount: 0, eligible: true },
      { senderId: "aunt", name: "Aunt", swearCount: 0, unpaidCount: 0, eligible: false },
    ];
    expect(pickWinner(standings)?.senderId).toBe("emma");
    expect(biggestSinner(standings)?.senderId).toBe("dad");
  });
});
