import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";

const deployedEnv = {
  NEXUS_ENV: "prod",
  FASTAPI_BASE_URL: "https://api.nexus.test",
  R2_S3_API_ORIGIN: "https://acct.r2.cloudflarestorage.com",
  NEXUS_INTERNAL_SECRET: "deploy-secret",
  AUTH_ALLOWED_REDIRECT_ORIGINS: "https://app.nexus.test",
};

async function loadConfig(env: Record<string, string>): Promise<NextConfig> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return (await import("../next.config")).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("next.config Server Actions", () => {
  it("omits allowedOrigins for direct same-origin Vercel deployments", async () => {
    const config = await loadConfig(deployedEnv);

    expect(config.experimental?.serverActions).toEqual({
      bodySizeLimit: "1mb",
    });
  });

  it("passes explicit host-rewriting domain patterns to Next", async () => {
    const config = await loadConfig({
      ...deployedEnv,
      SERVER_ACTION_ALLOWED_ORIGINS:
        "App.Nexus.test, *.Proxy.Nexus.test, app.nexus.test",
    });

    expect(config.experimental?.serverActions).toEqual({
      bodySizeLimit: "1mb",
      allowedOrigins: ["app.nexus.test", "*.proxy.nexus.test"],
    });
  });
});

describe("next.config images", () => {
  it("optimizes only public owned Oracle plate images", async () => {
    const config = await loadConfig(deployedEnv);

    expect(config.images?.localPatterns).toEqual([
      {
        pathname: "/api/oracle/plates/**",
      },
    ]);
    expect(config.images?.localPatterns).not.toContainEqual({
      pathname: "/api/media/image",
    });
  });
});

describe("next.config redirects", () => {
  it("redirects the root to the canonical authenticated home", async () => {
    const config = await loadConfig(deployedEnv);
    const redirects = await config.redirects?.();

    expect(redirects?.find(({ source }) => source === "/")).toEqual({
      source: "/",
      destination: APP_AUTHENTICATED_HOME_HREF,
      permanent: false,
    });
  });
});
