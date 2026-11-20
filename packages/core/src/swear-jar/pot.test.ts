import { describe, expect, it } from "vitest";

import { potAccountNameForConversation, potSmartAccountName } from "./constants.js";

describe("pot account names", () => {
  it("is stable and CDP-safe per conversation", () => {
    const a = potAccountNameForConversation("any;+;group-guid-aaa");
    const b = potAccountNameForConversation("any;+;group-guid-aaa");
    const c = potAccountNameForConversation("any;+;group-guid-bbb");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^sj-[a-f0-9]{28}$/);
    expect(a.length).toBeLessThanOrEqual(36);
    expect(potSmartAccountName(a)).toMatch(/^sa-[a-f0-9]{28}$/);
  });
});
