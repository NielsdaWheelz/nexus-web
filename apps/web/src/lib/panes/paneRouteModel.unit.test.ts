import { describe, expect, it } from "vitest";
import { resolvePaneRouteModel } from "./paneRouteModel";

const READING_ID = "abcdefab-cdef-4abc-8def-abcdefabcdef";

describe("pane route resolution", () => {
  it("accepts only canonical Oracle reading resource identifiers", () => {
    expect(resolvePaneRouteModel(`/oracle/${READING_ID}`)).toMatchObject({
      id: "oracleReading",
      params: { readingId: READING_ID },
    });

    expect(resolvePaneRouteModel("/oracle/atlas").id).toBe("unsupported");
    expect(resolvePaneRouteModel("/oracle/not-a-uuid").id).toBe("unsupported");
    expect(
      resolvePaneRouteModel(`/oracle/${READING_ID.toUpperCase()}`).id,
    ).toBe("unsupported");
  });

  it("keeps the Grand Atlas as the only Atlas route", () => {
    expect(resolvePaneRouteModel("/atlas?layer=readings")).toMatchObject({
      id: "atlas",
      pathname: "/atlas",
    });
  });
});
