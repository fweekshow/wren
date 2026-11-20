import { describe, expect, it } from "vitest";

import { detectSwear } from "./detect.js";

describe("detectSwear", () => {
  it("matches film lines", () => {
    expect(detectSwear("this is bullshit")).toBe(true);
    expect(detectSwear("bull shit")).toBe(true);
    expect(detectSwear("oh hell no")).toBe(true);
    expect(detectSwear("what the hell")).toBe(true);
    expect(detectSwear("what the fuck")).toBe(true);
    expect(detectSwear("damn it")).toBe(true);
    expect(detectSwear("goddamn")).toBe(true);
    expect(detectSwear("wtf")).toBe(true);
    expect(detectSwear("asshole")).toBe(true);
    expect(detectSwear("you bitch")).toBe(true);
    expect(detectSwear("motherfucker")).toBe(true);
    expect(detectSwear("cunt")).toBe(true);
    expect(detectSwear("f*ck")).toBe(true);
    expect(detectSwear("fvck")).toBe(true);
    expect(detectSwear("sh1t")).toBe(true);
    expect(detectSwear("b1tch")).toBe(true);
  });

  it("does not match mild words the AI judge must decide", () => {
    expect(detectSwear("piss")).toBe(false);
    expect(detectSwear("butt")).toBe(false);
    expect(detectSwear("pee in the butt")).toBe(false);
    expect(detectSwear("piss in the butt")).toBe(false);
  });

  it("does not match clean / false-positive words", () => {
    expect(detectSwear("class")).toBe(false);
    expect(detectSwear("assume")).toBe(false);
    expect(detectSwear("hello")).toBe(false);
    expect(detectSwear("shell")).toBe(false);
    expect(detectSwear("what the")).toBe(false);
    // standalone hell / damn / ass dropped for the video
    expect(detectSwear("hell")).toBe(false);
    expect(detectSwear("damn")).toBe(false);
    expect(detectSwear("ass")).toBe(false);
  });
});
