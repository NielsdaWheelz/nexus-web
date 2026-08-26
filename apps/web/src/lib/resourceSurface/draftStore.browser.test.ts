import { beforeEach, describe, expect, it } from "vitest";
import {
  readResourceSurfaceDraft,
  resourceSurfaceDraftStorageKey,
} from "./draftStore";

describe("resource surface draft browser boundary", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("preserves malformed authored recovery data while surfacing the defect", () => {
    const sourceRef = "page:aaaaaaaa-1111-4111-8111-111111111111";
    const key = resourceSurfaceDraftStorageKey(sourceRef);
    const malformed = JSON.stringify({ version: 1, legacy: "Keep me" });
    window.localStorage.setItem(key, malformed);

    expect(() => readResourceSurfaceDraft(sourceRef)).toThrow(
      "resource surface draft must contain exactly",
    );
    expect(window.localStorage.getItem(key)).toBe(malformed);
  });
});
