import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  __resetEnvForTests,
  getEnv,
  isDeployed,
  isDevBuild,
  isProdBuild,
  nexusEnv,
} from "./env";

// A valid deployed env so getEnv() resolves without throwing; individual tests then break one
// var to prove the build gate fires.
function stubDeployed(env: "staging" | "prod") {
  vi.stubEnv("NEXUS_ENV", env);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("FASTAPI_BASE_URL", "https://api.nexus.app");
  vi.stubEnv("R2_S3_API_ORIGIN", "https://acc.r2.cloudflarestorage.com");
  vi.stubEnv("NEXUS_INTERNAL_SECRET", "deploy-secret");
  vi.stubEnv("AUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.nexus.app");
}

beforeEach(() => __resetEnvForTests());
afterEach(() => {
  vi.unstubAllEnvs();
  __resetEnvForTests();
});

describe("nexusEnv (deployment axis)", () => {
  it("defaults to local when NEXUS_ENV is unset", () => {
    expect(nexusEnv()).toBe("local");
  });

  it.each(["local", "test", "staging", "prod"] as const)(
    "parses %s",
    (env) => {
      vi.stubEnv("NEXUS_ENV", env);
      expect(nexusEnv()).toBe(env);
    },
  );

  it("throws on an unrecognized value", () => {
    vi.stubEnv("NEXUS_ENV", "production"); // a NODE_ENV value, not a NexusEnv
    expect(() => nexusEnv()).toThrow(/Invalid NEXUS_ENV/);
  });

  it("isDeployed is true only for staging and prod", () => {
    vi.stubEnv("NEXUS_ENV", "staging");
    expect(isDeployed()).toBe(true);
    vi.stubEnv("NEXUS_ENV", "prod");
    expect(isDeployed()).toBe(true);
    vi.stubEnv("NEXUS_ENV", "test");
    expect(isDeployed()).toBe(false);
  });
});

describe("build mode (NODE_ENV) never reads the deployment axis", () => {
  it("isProdBuild tracks NODE_ENV, not the deployment axis", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXUS_ENV", "test");
    expect(isProdBuild()).toBe(true);
    expect(isDeployed()).toBe(false);
  });

  it("isDevBuild tracks NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isDevBuild()).toBe(true);
    expect(isProdBuild()).toBe(false);
  });
});

// The exact rows of the spec's §8 matrix. The first row is the original outage: a production
// build that is NOT the prod deployment.
describe("axis decoupling matrix (§8)", () => {
  it("make web-e2e (NODE_ENV=production, NEXUS_ENV=test): not deployed, CSP disabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXUS_ENV", "test");
    vi.stubEnv("E2E_DISABLE_CSP", "1");
    expect(isDeployed()).toBe(false);
    expect(isDevBuild()).toBe(false);
    expect(getEnv().disableCspForE2E).toBe(true);
  });

  it("next dev (NODE_ENV=development, NEXUS_ENV=local): dev build, flag honored", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXUS_ENV", "local");
    vi.stubEnv("E2E_DISABLE_CSP", "1");
    expect(isDevBuild()).toBe(true);
    expect(isDeployed()).toBe(false);
    expect(getEnv().disableCspForE2E).toBe(true);
  });

  it("real-media E2E (NODE_ENV=production, NEXUS_ENV=local): flag honored", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXUS_ENV", "local");
    vi.stubEnv("E2E_DISABLE_CSP", "1");
    expect(isDeployed()).toBe(false);
    expect(getEnv().disableCspForE2E).toBe(true);
  });

  it("strict-CSP E2E (NEXUS_ENV=test, E2E_DISABLE_CSP=0): CSP enforced", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXUS_ENV", "test");
    vi.stubEnv("E2E_DISABLE_CSP", "0");
    expect(getEnv().disableCspForE2E).toBe(false);
  });

  it("staging deploy: isDeployed true, CSP cannot be disabled even with E2E_DISABLE_CSP=1", () => {
    stubDeployed("staging");
    vi.stubEnv("E2E_DISABLE_CSP", "1");
    expect(nexusEnv()).toBe("staging");
    expect(isDeployed()).toBe(true);
    expect(getEnv().disableCspForE2E).toBe(false);
  });

  it("prod deploy: isDeployed true, CSP cannot be disabled", () => {
    stubDeployed("prod");
    vi.stubEnv("E2E_DISABLE_CSP", "1");
    expect(nexusEnv()).toBe("prod");
    expect(isDeployed()).toBe(true);
    expect(getEnv().disableCspForE2E).toBe(false);
  });
});

describe("getEnv() (resolve-once, frozen)", () => {
  it("returns a frozen object and memoizes it within the process", () => {
    vi.stubEnv("FASTAPI_BASE_URL", "https://api.example.com");
    const first = getEnv();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.internalApi)).toBe(true);
    expect(getEnv()).toBe(first);
  });

  it("__resetEnvForTests clears the memo so a re-stub takes effect", () => {
    vi.stubEnv("R2_S3_API_ORIGIN", "");
    vi.stubEnv("FASTAPI_BASE_URL", "https://one.example.com");
    expect(getEnv().connectOrigins).toEqual(["https://one.example.com"]);
    __resetEnvForTests();
    vi.stubEnv("R2_S3_API_ORIGIN", "");
    vi.stubEnv("FASTAPI_BASE_URL", "https://two.example.com");
    expect(getEnv().connectOrigins).toEqual(["https://two.example.com"]);
  });
});

describe("getEnv().connectOrigins", () => {
  it("returns the FastAPI + R2 origins", () => {
    vi.stubEnv("FASTAPI_BASE_URL", "https://api.example.com");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://acc.r2.cloudflarestorage.com");
    expect(getEnv().connectOrigins).toEqual([
      "https://api.example.com",
      "https://acc.r2.cloudflarestorage.com",
    ]);
  });

  it("skips entries with a path/query outside a deployed env", () => {
    vi.stubEnv("FASTAPI_BASE_URL", "https://api.example.com/v1");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://acc.r2.cloudflarestorage.com/path");
    expect(getEnv().connectOrigins).toEqual([]);
  });

  it("allows http localhost", () => {
    vi.stubEnv("FASTAPI_BASE_URL", "http://localhost:8000");
    vi.stubEnv("R2_S3_API_ORIGIN", "http://127.0.0.1:9000");
    expect(getEnv().connectOrigins).toEqual([
      "http://localhost:8000",
      "http://127.0.0.1:9000",
    ]);
  });
});

describe("getEnv().serverActionAllowedOrigins", () => {
  it("defaults to same-origin Server Actions", () => {
    expect(getEnv().serverActionAllowedOrigins).toEqual([]);
  });

  it("normalizes and dedupes Next.js domain patterns", () => {
    vi.stubEnv(
      "SERVER_ACTION_ALLOWED_ORIGINS",
      "App.Example.com, *.Proxy.Example.com, app.example.com"
    );

    expect(getEnv().serverActionAllowedOrigins).toEqual([
      "app.example.com",
      "*.proxy.example.com",
    ]);
  });

  it("rejects URL-style Server Action origins", () => {
    vi.stubEnv("SERVER_ACTION_ALLOWED_ORIGINS", "https://app.example.com");

    expect(() => getEnv()).toThrow(/SERVER_ACTION_ALLOWED_ORIGINS/);
  });

  it("rejects broad wildcards", () => {
    vi.stubEnv("SERVER_ACTION_ALLOWED_ORIGINS", "*");

    expect(() => getEnv()).toThrow(/SERVER_ACTION_ALLOWED_ORIGINS/);

    __resetEnvForTests();
    vi.stubEnv("SERVER_ACTION_ALLOWED_ORIGINS", "*.com");

    expect(() => getEnv()).toThrow(/SERVER_ACTION_ALLOWED_ORIGINS/);

    __resetEnvForTests();
    vi.stubEnv("SERVER_ACTION_ALLOWED_ORIGINS", "*.co.uk");

    expect(() => getEnv()).toThrow(/SERVER_ACTION_ALLOWED_ORIGINS/);
  });

  it("rejects localhost in deployed builds", () => {
    stubDeployed("prod");
    vi.stubEnv("SERVER_ACTION_ALLOWED_ORIGINS", "localhost");

    expect(() => getEnv()).toThrow(/localhost/);
  });
});

describe("auth redirect origin deployment validation", () => {
  it("requires AUTH_ALLOWED_REDIRECT_ORIGINS in deployed builds", () => {
    stubDeployed("prod");
    vi.stubEnv("AUTH_ALLOWED_REDIRECT_ORIGINS", "");

    expect(() => getEnv()).toThrow(/AUTH_ALLOWED_REDIRECT_ORIGINS/);
  });

  it("rejects invalid AUTH_ALLOWED_REDIRECT_ORIGINS entries", () => {
    stubDeployed("prod");
    vi.stubEnv("AUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com/path");

    expect(() => getEnv()).toThrow(/AUTH_ALLOWED_REDIRECT_ORIGINS/);
  });

  it("rejects non-HTTPS app redirect origins in deployed builds", () => {
    stubDeployed("prod");
    vi.stubEnv("AUTH_ALLOWED_REDIRECT_ORIGINS", "http://app.example.com");

    expect(() => getEnv()).toThrow(/HTTPS/);
  });

  it("requires Server Action allowed origins for deployed trusted-proxy auth origins", () => {
    stubDeployed("prod");
    vi.stubEnv("AUTH_TRUSTED_PROXY_ORIGINS", "https://proxy.internal");

    expect(() => getEnv()).toThrow(/SERVER_ACTION_ALLOWED_ORIGINS/);
  });

  it("allows trusted-proxy auth origins when the Server Action admission list is explicit", () => {
    stubDeployed("prod");
    vi.stubEnv("AUTH_TRUSTED_PROXY_ORIGINS", "https://proxy.internal");
    vi.stubEnv("SERVER_ACTION_ALLOWED_ORIGINS", "app.nexus.app");

    expect(getEnv().serverActionAllowedOrigins).toEqual(["app.nexus.app"]);
  });
});

// The build gate. These are the assertions the middleware/route runtime tests used to make
// against "missing env in production"; they now live here, because the failure is converted
// from a per-request 500 into a failed `next build`.
describe("getEnv deployed build gate", () => {
  it("throws when FASTAPI_BASE_URL is missing in a deployed env", () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    vi.stubEnv("FASTAPI_BASE_URL", "");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://acc.r2.cloudflarestorage.com");
    vi.stubEnv("NEXUS_INTERNAL_SECRET", "s");
    expect(() => getEnv()).toThrow(/FASTAPI_BASE_URL/);
  });

  it("throws when R2_S3_API_ORIGIN is missing in a deployed env", () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    vi.stubEnv("FASTAPI_BASE_URL", "https://api.example.com");
    vi.stubEnv("R2_S3_API_ORIGIN", "");
    vi.stubEnv("NEXUS_INTERNAL_SECRET", "s");
    expect(() => getEnv()).toThrow(/R2_S3_API_ORIGIN/);
  });

  it("throws when R2_S3_API_ORIGIN is not the Cloudflare R2 host", () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    vi.stubEnv("FASTAPI_BASE_URL", "https://api.example.com");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://storage.example.com");
    vi.stubEnv("NEXUS_INTERNAL_SECRET", "s");
    expect(() => getEnv()).toThrow(/R2_S3_API_ORIGIN/);
  });

  it("throws on a non-HTTPS, non-localhost FastAPI origin in a deployed env", () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    vi.stubEnv("FASTAPI_BASE_URL", "http://api.example.com");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://acc.r2.cloudflarestorage.com");
    vi.stubEnv("NEXUS_INTERNAL_SECRET", "s");
    expect(() => getEnv()).toThrow(/FASTAPI_BASE_URL/);
  });

  it("throws when NEXUS_INTERNAL_SECRET is missing in a deployed env", () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    vi.stubEnv("FASTAPI_BASE_URL", "https://api.example.com");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://acc.r2.cloudflarestorage.com");
    vi.stubEnv("AUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com");
    vi.stubEnv("NEXUS_INTERNAL_SECRET", "");
    expect(() => getEnv()).toThrow(/NEXUS_INTERNAL_SECRET/);
  });

  it("fires the same strict validation for staging", () => {
    vi.stubEnv("NEXUS_ENV", "staging");
    vi.stubEnv("FASTAPI_BASE_URL", "");
    expect(() => getEnv()).toThrow(/FASTAPI_BASE_URL/);
  });

  it("is a no-op for a local/test build with missing env", () => {
    vi.stubEnv("NEXUS_ENV", "test");
    vi.stubEnv("FASTAPI_BASE_URL", "");
    vi.stubEnv("R2_S3_API_ORIGIN", "");
    expect(() => getEnv()).not.toThrow();
  });
});

describe("getEnv().internalApi", () => {
  it("defaults fastApiBaseUrl to localhost and tolerates a missing secret outside deployed envs", () => {
    vi.stubEnv("NEXUS_ENV", "local");
    expect(getEnv().internalApi).toEqual({
      fastApiBaseUrl: "http://localhost:8000",
      internalSecret: "",
    });
  });
});

// env.ts owns NEXUS_INTERNAL_SECRET, so importing it into a client bundle would ship the
// secret-owning module. The boundary cannot be enforced with `import "server-only"` (next.config
// imports env.ts), so it is enforced here: no Client Component may import @/lib/env.
describe("client/server boundary", () => {
  it('no "use client" file imports @/lib/env', () => {
    const srcDir = fileURLToPath(new URL("..", import.meta.url));
    const offenders = sourceFiles(srcDir).filter((file) => {
      const text = readFileSync(file, "utf8");
      const start = text.trimStart();
      const isClient =
        start.startsWith('"use client"') || start.startsWith("'use client'");
      return isClient && /from\s+["']@\/lib\/env["']/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
