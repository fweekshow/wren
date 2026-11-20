import { describe, expect, it } from "vitest";

import { normalizeButtonActionKey } from "./user.adapter.js";

describe("normalizeButtonActionKey", () => {
  it("collapses ephemeral confirm/selection IDs", () => {
    expect(normalizeButtonActionKey("yes-1730123456789")).toBe("yes");
    expect(normalizeButtonActionKey("no-1730123456789")).toBe("no");
    expect(normalizeButtonActionKey("confirm-1730123456789")).toBe("confirm");
    expect(normalizeButtonActionKey("selection-1730123456789")).toBe("selection");
  });

  it("normalizes join group actions", () => {
    expect(normalizeButtonActionKey("join_a1b2c3d4_group")).toBe("join_group");
  });

  it("keeps stable action IDs unchanged", () => {
    expect(normalizeButtonActionKey("trending_groups")).toBe("trending_groups");
    expect(normalizeButtonActionKey("show_main_menu")).toBe("show_main_menu");
  });
});
