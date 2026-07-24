import {
  absoluteNexusHref,
  assumeNexusHref,
  routeShareTarget,
} from "@/lib/sharing/targets";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("route sharing targets", () => {
  it("accepts only supported canonical in-app paths", () => {
    expect(routeShareTarget({ href: "/notes", label: " Notes " })).toEqual({
      kind: "Route",
      href: "/notes",
      label: "Notes",
    });
    expect(() => assumeNexusHref("//attacker.example/notes")).toThrow();
    expect(() => assumeNexusHref("/notes?redirect=attacker")).toThrow();
    expect(() => assumeNexusHref("/unsupported")).toThrow();
  });

  it("uses the validated build origin for absolute links", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_APP_PUBLIC_ORIGIN",
      "https://canonical.nexus.example",
    );

    expect(absoluteNexusHref(assumeNexusHref("/notes"))).toBe(
      "https://canonical.nexus.example/notes",
    );
  });
});
