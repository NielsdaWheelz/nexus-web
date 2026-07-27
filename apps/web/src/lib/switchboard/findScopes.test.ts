import { describe, expect, it } from "vitest";
import {
  switchboardOpenableSchemes,
  switchboardSearchQuery,
} from "./findScopes";

describe("Switchboard Find scopes", () => {
  it("excludes Web explicitly from All deep search", () => {
    expect(switchboardOpenableSchemes("All")).toEqual({ kind: "Absent" });
    expect([
      ...(switchboardSearchQuery("All", "needle")?.requestedKinds ?? []),
    ]).toEqual([
      "documents",
      "notes",
      "highlights",
      "conversations",
      "people",
    ]);
  });

  it("keeps highlight notes server-classified", () => {
    expect(switchboardOpenableSchemes("Highlights")).toEqual({
      kind: "Present",
      value: ["highlight"],
    });
    expect([
      ...(switchboardSearchQuery("Highlights", "needle")?.requestedKinds ?? []),
    ]).toEqual(["highlights"]);
  });

  it("does not issue a deep search for Libraries", () => {
    expect(switchboardOpenableSchemes("Libraries")).toEqual({
      kind: "Present",
      value: ["library"],
    });
    expect(switchboardSearchQuery("Libraries", "needle")).toBeNull();
  });
});
