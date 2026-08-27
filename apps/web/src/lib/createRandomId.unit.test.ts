import { afterEach, describe, expect, it, vi } from "vitest";

import { createRandomId } from "./createRandomId";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRandomId", () => {
  it("returns a secure UUID with the optional diagnostic prefix", () => {
    expect(createRandomId()).toMatch(UUID_V4_RE);
    expect(createRandomId("media-upload")).toMatch(
      new RegExp(`^media-upload-${UUID_V4_RE.source.slice(1)}`),
    );
  });

  it("defects when the supported runtime lacks secure UUID generation", () => {
    vi.stubGlobal("crypto", undefined);

    expect(() => createRandomId()).toThrow(
      "Secure random UUID generation is unavailable",
    );
  });
});
