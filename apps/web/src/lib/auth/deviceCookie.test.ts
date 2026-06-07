import { beforeAll, describe, expect, it } from "vitest";
import {
  DEVICE_COOKIE_NAME,
  mintDeviceId,
  readDeviceId,
} from "@/lib/auth/deviceCookie";

// deviceCookie.ts imports @/lib/env (isDeployed), which reads process.env.NEXUS_ENV lazily and
// defaults to "local" (non-deployed). Pin it so the test is deterministic regardless of the
// runner's ambient env, and so isDeployed() can never throw on an unexpected value.
beforeAll(() => {
  process.env.NEXUS_ENV = "local";
});

describe("deviceCookie", () => {
  it("names the cookie nx_device", () => {
    expect(DEVICE_COOKIE_NAME).toBe("nx_device");
  });

  it("readDeviceId returns the cookie value when present", () => {
    const store = {
      get: (name: string) => (name === "nx_device" ? { value: "abc" } : undefined),
    };
    expect(readDeviceId(store)).toBe("abc");
  });

  it("readDeviceId returns null when the cookie is absent", () => {
    const store = { get: () => undefined };
    expect(readDeviceId(store)).toBeNull();
  });

  it("mintDeviceId returns a non-empty value and a boolean secure flag", () => {
    const { value, options } = mintDeviceId();
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThan(0);
    // secure is env-dependent (Secure in deployed envs only) — assert it's a boolean, not a value.
    expect(typeof options.secure).toBe("boolean");
  });

  it("mintDeviceId returns the server-owned httpOnly cookie options", () => {
    const { options } = mintDeviceId();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBeGreaterThan(0);
  });

  it("mintDeviceId returns a fresh value on each call", () => {
    expect(mintDeviceId().value).not.toBe(mintDeviceId().value);
  });
});
