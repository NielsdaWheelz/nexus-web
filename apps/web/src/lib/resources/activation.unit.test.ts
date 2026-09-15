import { describe, expect, it } from "vitest";

import {
  decodeCamelCaseResourceActivation,
  decodeSnakeCaseResourceActivation,
  normalizeResourceActivation,
} from "./activation";

const MEDIA_REF = "media:11111111-1111-4111-8111-111111111111";

const SNAKE_ROUTE = {
  resource_ref: MEDIA_REF,
  kind: "route",
  href: "/media/11111111-1111-4111-8111-111111111111",
  unresolved_reason: null,
};

const CAMEL_NONE = {
  resourceRef: MEDIA_REF,
  kind: "none",
  href: null,
  unresolvedReason: "missing",
};

describe("resource activation wire owner", () => {
  it("decodes the exact snake_case wire into the routeable variant", () => {
    expect(decodeSnakeCaseResourceActivation(SNAKE_ROUTE)).toEqual({
      resourceRef: MEDIA_REF,
      kind: "route",
      href: SNAKE_ROUTE.href,
      unresolvedReason: null,
    });
  });

  it("decodes the exact camelCase wire into the unrouteable variant", () => {
    expect(decodeCamelCaseResourceActivation(CAMEL_NONE)).toEqual(CAMEL_NONE);
  });

  it.each([
    { raw: { ...SNAKE_ROUTE, extra: true }, name: "extra snake_case field" },
    {
      raw: { ...SNAKE_ROUTE, resource_ref: "media:not-a-uuid" },
      name: "invalid ref",
    },
    { raw: { ...SNAKE_ROUTE, href: null }, name: "route without href" },
    { raw: { ...SNAKE_ROUTE, kind: "none" }, name: "none with href" },
  ])("rejects $name", ({ raw }) => {
    expect(() => decodeSnakeCaseResourceActivation(raw)).toThrow(TypeError);
  });

  it("rejects alternate casing instead of treating it as compatibility input", () => {
    expect(() => decodeCamelCaseResourceActivation(SNAKE_ROUTE)).toThrow(
      TypeError,
    );
    expect(() => decodeSnakeCaseResourceActivation(CAMEL_NONE)).toThrow(
      TypeError,
    );
  });

  it("keeps replayed-content normalization nullable while using the strict contract", () => {
    expect(normalizeResourceActivation(SNAKE_ROUTE)).not.toBeNull();
    expect(
      normalizeResourceActivation({ ...SNAKE_ROUTE, kind: "none" }),
    ).toBeNull();
  });
});
