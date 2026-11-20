import { describe, expect, it } from "vitest";

import {
  matchHelp,
  matchNah,
  matchOff,
  matchOn,
  matchOptIn,
  matchOptOut,
  matchSecrets,
  matchSettle,
  matchStatus,
  normalizeCommand,
} from "./commands.js";

describe("alexander commands", () => {
  it("matchOn / matchOff need explicit jar verbs", () => {
    expect(matchOn(normalizeCommand("alexander on"))).toBe(true);
    expect(matchOn(normalizeCommand("summon alexander"))).toBe(true);
    expect(matchOff(normalizeCommand("alexander off"))).toBe(true);
    expect(matchOn(normalizeCommand("alexander"))).toBe(false);
    expect(matchOff(normalizeCommand("alexander is offline"))).toBe(false);
  });

  it("matchStatus accepts pot/jar checks, not bare alexander", () => {
    expect(matchStatus(normalizeCommand("how's alexander"))).toBe(true);
    expect(matchStatus(normalizeCommand("hows the jar"))).toBe(true);
    expect(matchStatus(normalizeCommand("alexander what's in the pot"))).toBe(true);
    expect(matchStatus(normalizeCommand("Alexander what's in the pot"))).toBe(true);
    expect(matchStatus(normalizeCommand("what's in the pot"))).toBe(true);
    expect(matchStatus(normalizeCommand("check pot"))).toBe(true);
    expect(matchStatus(normalizeCommand("what's in the jar"))).toBe(true);
    expect(matchStatus(normalizeCommand("What's in the jar"))).toBe(true);
    expect(matchStatus(normalizeCommand("Sir Alexander what's in the jar?"))).toBe(true);
    expect(matchStatus(normalizeCommand("Alexander what's in the jar?"))).toBe(true);
    expect(matchStatus(normalizeCommand("what\u2019s in the jar"))).toBe(true);
    expect(matchStatus(normalizeCommand("alexander standings"))).toBe(true);

    expect(matchStatus(normalizeCommand("alexander"))).toBe(false);
    expect(matchStatus(normalizeCommand("alexander?"))).toBe(false);
    expect(matchStatus(normalizeCommand("jar"))).toBe(false);
    expect(matchStatus(normalizeCommand("tell alexander dinner is ready"))).toBe(false);
    expect(matchStatus(normalizeCommand("alexander is coming over"))).toBe(false);
  });

  it("matchSettle works without @basemate phrasing", () => {
    expect(matchSettle(normalizeCommand("alexander settle"))).toBe(true);
    expect(matchSettle(normalizeCommand("Alexander settle"))).toBe(true);
    expect(matchSettle(normalizeCommand("settle the jar"))).toBe(true);
    expect(matchSettle(normalizeCommand("empty the jar"))).toBe(true);
    expect(matchSettle(normalizeCommand("release the pot"))).toBe(true);
    expect(matchSettle(normalizeCommand("settle the pot"))).toBe(true);

    expect(matchSettle(normalizeCommand("settle"))).toBe(false);
    expect(matchSettle(normalizeCommand("alexander"))).toBe(false);
    expect(matchSettle(normalizeCommand("we should settle this later"))).toBe(false);
    expect(matchSettle(normalizeCommand("alexander is settling in"))).toBe(false);
  });

  it("matchNah", () => {
    expect(matchNah(normalizeCommand("nah"))).toBe(true);
    expect(matchNah(normalizeCommand("wasn't a swear"))).toBe(true);
    expect(matchNah(normalizeCommand("nah that was a quote"))).toBe(true);
  });

  it("matchHelp needs alexander/jar intent", () => {
    expect(matchHelp(normalizeCommand("alexander help"))).toBe(true);
    expect(matchHelp(normalizeCommand("help alexander"))).toBe(true);
    expect(matchHelp(normalizeCommand("what can alexander do"))).toBe(true);
    expect(matchHelp(normalizeCommand("swear jar help"))).toBe(true);
    expect(matchHelp(normalizeCommand("help"))).toBe(false);
    expect(matchHelp(normalizeCommand("alexander"))).toBe(false);
    expect(matchHelp(normalizeCommand("can you help me send usdc"))).toBe(false);
  });

  it("matchOptIn / matchOptOut are personal, not group on/off", () => {
    expect(matchOptIn(normalizeCommand("count me in"))).toBe(true);
    expect(matchOptIn(normalizeCommand("opt in"))).toBe(true);
    expect(matchOptIn(normalizeCommand("put me on the jar"))).toBe(true);
    expect(matchOptOut(normalizeCommand("off my tab"))).toBe(true);
    expect(matchOptOut(normalizeCommand("don't charge me"))).toBe(true);
    expect(matchOptIn(normalizeCommand("alexander on"))).toBe(false);
    expect(matchOptOut(normalizeCommand("alexander off"))).toBe(false);
  });

  it("matchSecrets refuses to list the ledger", () => {
    expect(matchSecrets(normalizeCommand("what counts as a swear"))).toBe(true);
    expect(matchSecrets(normalizeCommand("Alexander what counts as a swear word"))).toBe(true);
    expect(matchSecrets(normalizeCommand("what's a swear"))).toBe(true);
    expect(matchSecrets(normalizeCommand("list the swears"))).toBe(true);
    expect(matchSecrets(normalizeCommand("how's alexander"))).toBe(false);
  });
});
