import { describe, expect, it } from "vitest";

import {
  applyThresholds,
  hasBrainCue,
  hasIntentCue,
  looksQuoted,
  resolveArmedFastPath,
} from "./brain.js";
import { normalizeCommand } from "./commands.js";

describe("hasBrainCue / hasIntentCue", () => {
  it("fires on jar / pot / alexander action cues", () => {
    expect(hasIntentCue("what's in the jar")).toBe(true);
    expect(hasIntentCue("empty the jar")).toBe(true);
    expect(hasIntentCue("count me in")).toBe(true);
    expect(hasIntentCue("off my tab")).toBe(true);
    expect(hasBrainCue("piss in the butt")).toBe(true);
  });

  it("skips ordinary chatter so we do not call the model", () => {
    expect(hasBrainCue("Cool")).toBe(false);
    expect(hasBrainCue("how's dinner")).toBe(false);
    expect(hasIntentCue("we should settle this later")).toBe(false);
  });

  it("treats @basemate + alexander-ish as a cue", () => {
    expect(hasBrainCue("turn him off", { mentioned: true })).toBe(false);
    expect(hasBrainCue("alexander dinner is ready", { mentioned: true })).toBe(true);
  });
});

describe("looksQuoted", () => {
  it("flags attributed / sung swears", () => {
    expect(looksQuoted("he said fuck you")).toBe(true);
    expect(looksQuoted("dad said this is bullshit")).toBe(true);
    expect(looksQuoted("she was singing damn it")).toBe(true);
  });

  it("does not flag film-script curses", () => {
    expect(looksQuoted("this is bullshit")).toBe(false);
    expect(looksQuoted("what the fuck")).toBe(false);
  });
});

describe("applyThresholds", () => {
  it("lets info through at 0.6", () => {
    expect(applyThresholds({ intent: "status", confidence: 0.6 })).toBe("status");
    expect(applyThresholds({ intent: "opt_in", confidence: 0.61 })).toBe("opt_in");
    expect(applyThresholds({ intent: "help", confidence: 0.59 })).toBe("ignore");
  });

  it("requires 0.85 for swear / settle, else settle_confirm", () => {
    expect(applyThresholds({ intent: "swear", confidence: 0.84 })).toBe("ignore");
    expect(applyThresholds({ intent: "swear", confidence: 0.85 })).toBe("swear");
    expect(applyThresholds({ intent: "settle", confidence: 0.85 })).toBe("settle");
    expect(applyThresholds({ intent: "settle", confidence: 0.7 })).toBe("settle_confirm");
  });

  it("fails closed on junk", () => {
    expect(applyThresholds({ intent: "explode", confidence: 1 })).toBe("ignore");
    expect(applyThresholds({ intent: "swear", confidence: Number.NaN })).toBe("ignore");
  });
});

describe("resolveArmedFastPath golden transcript", () => {
  const cases: [string, ReturnType<typeof resolveArmedFastPath>][] = [
    ["how's alexander", "status"],
    ["what's in the jar", "status"],
    ["What's in the jar", "status"],
    ["Sir Alexander what's in the jar?", "status"],
    ["Alexander what's in the jar?", "status"],
    ["what\u2019s in the jar", "status"],
    ["check pot", "status"],
    ["alexander settle", "settle"],
    ["empty the jar", "settle"],
    ["we should settle this later", "none"],
    ["tell alexander dinner is ready", "brain"],
    ["he said fuck you", "brain"],
    ["this is bullshit", "swear"],
    ["what the fuck", "swear"],
    ["f*ck", "swear"],
    ["piss", "brain"],
    ["piss in the butt", "brain"],
    ["butt", "brain"],
    ["Cool", "none"],
    ["nah", "nah"],
    ["count me in", "opt_in"],
    ["off my tab", "opt_out"],
    ["alexander off", "off"],
    ["jar off", "off"],
    ["alexander help", "help"],
    ["what counts as a swear", "secrets"],
    ["Alexander what counts as a swear word", "secrets"],
    ["how much is in the liquidity pot", "none"],
  ];

  it("routes the golden lines on regex / cue only", () => {
    for (const [text, expected] of cases) {
      expect(resolveArmedFastPath(text), text).toBe(expected);
    }
  });

  it("normalizes iMessage curly apostrophes before status match", () => {
    expect(normalizeCommand("what\u2019s in the jar")).toBe("what's in the jar");
  });
});
