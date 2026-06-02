import { afterEach, describe, expect, it, vi } from "vitest";
import { CspEvaluator } from "csp_evaluator/dist/evaluator.js";
import { Severity } from "csp_evaluator/dist/finding.js";
import { CspParser } from "csp_evaluator/dist/parser.js";
import {
  buildContentSecurityPolicy,
  buildReportingEndpoints,
  CSP_DIRECTIVES,
  CSP_REPORT_PATH,
  generateNonce,
  getConnectOriginsFromEnv,
  shouldDisableCspForE2E,
} from "./csp";

const PROD_OPTS = {
  nonce: "TESTNONCE",
  isDev: false,
  isHttpsRequest: true,
  connectOrigins: [
    "https://api.example.com",
    "https://acc.r2.cloudflarestorage.com",
  ],
} as const;

function parse(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values] as const;
    }),
  );
}

describe("CSP_DIRECTIVES (source of truth)", () => {
  it("keeps script-src strict (nonce + strict-dynamic, no self/unsafe-*)", () => {
    const scriptSrc = CSP_DIRECTIVES["script-src"];
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc.some((source) => source.includes("nonce-"))).toBe(true);
    expect(scriptSrc).not.toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("locks down object-src, base-uri, frame-ancestors, default-src", () => {
    expect(CSP_DIRECTIVES["object-src"]).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES["base-uri"]).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES["frame-ancestors"]).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES["default-src"]).toEqual(["'self'"]);
  });

  it("wires CSP reporting", () => {
    expect(CSP_DIRECTIVES["report-to"]).toEqual(["csp"]);
    expect(CSP_DIRECTIVES["report-uri"]).toEqual([CSP_REPORT_PATH]);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("produces the strict production policy", () => {
    const directives = parse(buildContentSecurityPolicy(PROD_OPTS));
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual([
      "'nonce-TESTNONCE'",
      "'strict-dynamic'",
    ]);
    expect(directives.get("connect-src")).toEqual([
      "'self'",
      "https://api.example.com",
      "https://acc.r2.cloudflarestorage.com",
    ]);
    expect(directives.get("media-src")).toEqual(["'self'", "https:"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.has("upgrade-insecure-requests")).toBe(true);
    expect(directives.get("report-to")).toEqual(["csp"]);
    expect(directives.get("report-uri")).toEqual([CSP_REPORT_PATH]);
  });

  it("substitutes the nonce placeholder", () => {
    expect(buildContentSecurityPolicy(PROD_OPTS)).not.toContain("{NONCE}");
  });

  it("adds 'unsafe-eval' and dev websocket origins only in dev", () => {
    const directives = parse(
      buildContentSecurityPolicy({
        ...PROD_OPTS,
        isDev: true,
        devWebSocketOrigins: ["ws://localhost:3000"],
      }),
    );
    expect(directives.get("script-src")).toContain("'unsafe-eval'");
    expect(directives.get("connect-src")).toContain("ws://localhost:3000");
  });

  it("omits upgrade-insecure-requests for non-HTTPS documents", () => {
    const directives = parse(
      buildContentSecurityPolicy({ ...PROD_OPTS, isHttpsRequest: false }),
    );
    expect(directives.has("upgrade-insecure-requests")).toBe(false);
  });
});

describe("getConnectOriginsFromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns FastAPI + R2 origins", () => {
    vi.stubEnv("FASTAPI_BASE_URL", "https://api.example.com");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://acc.r2.cloudflarestorage.com");
    expect(getConnectOriginsFromEnv()).toEqual([
      "https://api.example.com",
      "https://acc.r2.cloudflarestorage.com",
    ]);
  });

  it("skips entries with a path/query outside production", () => {
    vi.stubEnv("FASTAPI_BASE_URL", "https://api.example.com/v1");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://acc.r2.cloudflarestorage.com/path");
    expect(getConnectOriginsFromEnv()).toEqual([]);
  });

  it("allows http localhost", () => {
    vi.stubEnv("FASTAPI_BASE_URL", "http://localhost:8000");
    vi.stubEnv("R2_S3_API_ORIGIN", "http://127.0.0.1:9000");
    expect(getConnectOriginsFromEnv()).toContain("http://localhost:8000");
    expect(getConnectOriginsFromEnv()).toContain("http://127.0.0.1:9000");
  });

  it("throws in production when FASTAPI_BASE_URL is missing", () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    vi.stubEnv("FASTAPI_BASE_URL", "");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://acc.r2.cloudflarestorage.com");
    expect(() => getConnectOriginsFromEnv()).toThrow(/FASTAPI_BASE_URL/);
  });

  it("throws in production when R2_S3_API_ORIGIN is missing", () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    vi.stubEnv("FASTAPI_BASE_URL", "https://api.example.com");
    vi.stubEnv("R2_S3_API_ORIGIN", "");
    expect(() => getConnectOriginsFromEnv()).toThrow(/R2_S3_API_ORIGIN/);
  });

  it("throws in production on a non-HTTPS, non-localhost origin", () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    vi.stubEnv("FASTAPI_BASE_URL", "http://api.example.com");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://acc.r2.cloudflarestorage.com");
    expect(() => getConnectOriginsFromEnv()).toThrow(/FASTAPI_BASE_URL/);
  });

  it("throws in production when R2_S3_API_ORIGIN is not the Cloudflare R2 origin", () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    vi.stubEnv("FASTAPI_BASE_URL", "https://api.example.com");
    vi.stubEnv("R2_S3_API_ORIGIN", "https://storage.example.com");
    expect(() => getConnectOriginsFromEnv()).toThrow(/R2_S3_API_ORIGIN/);
  });
});

describe("shouldDisableCspForE2E", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is true outside production when E2E_DISABLE_CSP=1", () => {
    vi.stubEnv("E2E_DISABLE_CSP", "1");
    expect(shouldDisableCspForE2E()).toBe(true);
  });

  it("is false in production even when E2E_DISABLE_CSP=1", () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    vi.stubEnv("E2E_DISABLE_CSP", "1");
    expect(shouldDisableCspForE2E()).toBe(false);
  });
});

describe("generateNonce", () => {
  it("returns distinct base64 nonces of 16 bytes", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(atob(a).length).toBe(16);
  });
});

describe("buildReportingEndpoints", () => {
  it("builds an absolute same-origin Reporting-Endpoints value", () => {
    expect(buildReportingEndpoints("https://app.example.com")).toBe(
      'csp="https://app.example.com/api/csp-report"',
    );
    expect(CSP_REPORT_PATH).toBe("/api/csp-report");
  });
});

describe("CSP-Evaluator gate", () => {
  it("reports no HIGH-severity findings for the production policy", () => {
    const parsed = new CspParser(buildContentSecurityPolicy(PROD_OPTS)).csp;
    const findings = new CspEvaluator(parsed).evaluate();
    const high = findings
      .filter((finding) => finding.severity === Severity.HIGH)
      .map((finding) => `${finding.directive}: ${finding.description}`);
    expect(high).toEqual([]);
  });
});
