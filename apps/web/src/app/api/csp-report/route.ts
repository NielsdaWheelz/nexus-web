import { type NextRequest, NextResponse } from "next/server";

/**
 * Public CSP violation sink. Browsers POST here via the CSP `report-to`/`Reporting-Endpoints`
 * wiring (`application/reports+json`, an array of reports) and the legacy `report-uri`
 * directive (`application/csp-report`, a single object). Best-effort telemetry: parse, log a
 * structured line, always return 204. No auth (`/api/*` passes through middleware ungated),
 * no persistence. See docs/cutovers/csp-and-security-headers-hardening.md.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

// Reads either the modern reports+json body (camelCase) or the legacy csp-report (hyphenated).
function logViolation(body: Record<string, unknown>): void {
  console.warn("csp_violation", {
    blockedURL: readString(body, "blockedURL") ?? readString(body, "blocked-uri"),
    effectiveDirective:
      readString(body, "effectiveDirective") ??
      readString(body, "effective-directive") ??
      readString(body, "violated-directive"),
    documentURL:
      readString(body, "documentURL") ?? readString(body, "document-uri"),
    disposition: readString(body, "disposition"),
  });
}

const noContent = (): NextResponse => new NextResponse(null, { status: 204 });

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Reject oversized bodies before buffering them into memory on this public endpoint.
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return noContent();
    }

    const text = await request.text();
    if (text && text.length <= MAX_BODY_BYTES) {
      const parsed: unknown = JSON.parse(text);
      const reports: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const report of reports) {
        if (!isRecord(report)) continue;
        const body = report.body ?? report["csp-report"] ?? report;
        if (isRecord(body)) logViolation(body);
      }
    }
  } catch {
    // Best-effort telemetry — never fail a report POST.
  }
  return noContent();
}
