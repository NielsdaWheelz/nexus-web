import { describe, expect, it } from "vitest";
import {
  DESKTOP_CREATE_ACTION_IDS,
  QUICK_ACTION_REGISTRY,
  SWITCHBOARD_QUICK_ACTION_IDS,
} from "./quickActions";

describe("quick action projections", () => {
  it("keeps the mobile membership and semantic labels exact", () => {
    expect(
      SWITCHBOARD_QUICK_ACTION_IDS.map(
        (id) => QUICK_ACTION_REGISTRY[id].label,
      ),
    ).toEqual(["Note", "Page", "Chat", "Library", "Import", "Podcast"]);
  });

  it("keeps the desktop create projection to its existing three actions", () => {
    expect(
      DESKTOP_CREATE_ACTION_IDS.map((id) => QUICK_ACTION_REGISTRY[id].label),
    ).toEqual(["Chat", "Page", "Note"]);
  });
});
