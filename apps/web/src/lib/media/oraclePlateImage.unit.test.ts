import { describe, expect, it } from "vitest";
import {
  buildOraclePlateImageSrc,
  isOraclePlateImageSrc,
} from "./oraclePlateImage";

const PLATE_ID = "aaaaaaaa-1111-4111-8111-111111111111";

describe("Oracle plate image source", () => {
  it("accepts only the exact lowercase canonical API path", () => {
    expect(buildOraclePlateImageSrc(PLATE_ID)).toBe(
      `/api/oracle/plates/${PLATE_ID}`,
    );
    expect(isOraclePlateImageSrc(`/api/oracle/plates/${PLATE_ID}`)).toBe(true);
    expect(isOraclePlateImageSrc(`/api/oracle/plates/${PLATE_ID.toUpperCase()}`)).toBe(
      false,
    );
    expect(isOraclePlateImageSrc(`/api/oracle/plates/${PLATE_ID}/extra`)).toBe(
      false,
    );
  });
});
