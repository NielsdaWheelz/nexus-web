import { describe, it, expect } from "vitest";
import { parseAttachContext, stripAttachParams } from "./attachedContext";

describe("parseAttachContext", () => {
  it("returns highlight context for valid query", () => {
    const params = new URLSearchParams(
      "attach_type=highlight&attach_id=a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    const result = parseAttachContext(params);
    expect(result).toEqual([
      { type: "highlight", id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
    ]);
  });

  it("ignores invalid or unsupported values", () => {
    // Unsupported attach_type
    expect(
      parseAttachContext(
        new URLSearchParams(
          "attach_type=bookmark&attach_id=a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        ),
      ),
    ).toEqual([]);

    // Malformed UUID
    expect(
      parseAttachContext(
        new URLSearchParams("attach_type=highlight&attach_id=not-a-uuid"),
      ),
    ).toEqual([]);

    // Missing attach_id
    expect(
      parseAttachContext(new URLSearchParams("attach_type=highlight")),
    ).toEqual([]);

    // Missing attach_type
    expect(
      parseAttachContext(
        new URLSearchParams(
          "attach_id=a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        ),
      ),
    ).toEqual([]);

    // Both missing
    expect(parseAttachContext(new URLSearchParams())).toEqual([]);
  });
});

describe("stripAttachParams", () => {
  it("preserves unrelated query keys", () => {
    const params = new URLSearchParams(
      "attach_type=highlight&attach_id=a1b2c3d4-e5f6-7890-abcd-ef1234567890&foo=bar&baz=qux",
    );
    const result = stripAttachParams(params);
    expect(result.get("foo")).toBe("bar");
    expect(result.get("baz")).toBe("qux");
    expect(result.has("attach_type")).toBe(false);
    expect(result.has("attach_id")).toBe(false);
  });

  it("returns empty params when only attach keys present", () => {
    const params = new URLSearchParams(
      "attach_type=highlight&attach_id=a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    const result = stripAttachParams(params);
    expect(result.toString()).toBe("");
  });
});
