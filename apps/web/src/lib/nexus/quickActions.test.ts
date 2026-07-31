import { describe, expect, it } from "vitest";
import {
  NEXUS_ZERO_STATE_ACTION_IDS,
  QUICK_ACTION_REGISTRY,
  SWITCHBOARD_QUICK_ACTION_IDS,
} from "./quickActions";

describe("quick action projections", () => {
  it("keeps the mobile membership and semantic labels exact", () => {
    expect(
      SWITCHBOARD_QUICK_ACTION_IDS.map(
        (id) => QUICK_ACTION_REGISTRY[id].label,
      ),
    ).toEqual(["Quick Note", "Page", "Chat", "Library", "Import"]);
  });

  it("keeps the desktop zero-state actions exact", () => {
    expect(
      NEXUS_ZERO_STATE_ACTION_IDS.map(
        (id) => QUICK_ACTION_REGISTRY[id].label,
      ),
    ).toEqual(["Quick Note", "Chat", "Page", "Import"]);
  });
});
