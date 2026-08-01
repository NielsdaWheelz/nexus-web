import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const PORT_KEYS = [
  "postgres",
  "minio",
  "supabase_api",
  "supabase_db",
  "supabase_studio",
  "supabase_inbucket",
  "supabase_shadow",
  "api",
  "web",
  "external",
] as const;

type PortKey = (typeof PORT_KEYS)[number];

interface RuntimeRecord {
  version: number;
  repo_id: string;
  compose_project: string;
  supabase_workdir: string;
  ports: Record<PortKey, number>;
  owned_run_ids: string[];
}

export interface BrowserRuntime {
  repoRoot: string;
  webOrigin: string;
  apiOrigin: string;
  minioOrigin: string;
  supabaseOrigin: string;
  externalOrigin: string;
  browserOrigins: ReadonlySet<string>;
}

function parseRuntimeRecord(value: unknown, repoRoot: string): RuntimeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The Nexus test runtime record must be an object.");
  }
  const record = value as Record<string, unknown>;
  const repoId = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  const portsValue = record.ports;
  const ownedRunIds = record.owned_run_ids;
  const activeRunId = process.env.NEXUS_TEST_RUN_ID;
  if (
    record.version !== 2 ||
    record.repo_id !== repoId ||
    record.compose_project !== `nexus-test-${repoId}` ||
    record.supabase_workdir !== path.join(repoRoot, ".nexus-test", "supabase") ||
    !Array.isArray(ownedRunIds) ||
    !ownedRunIds.every(
      (runId) => typeof runId === "string" && /^[0-9a-f]{16}$/.test(runId),
    ) ||
    typeof activeRunId !== "string" ||
    !/^[0-9a-f]{16}$/.test(activeRunId) ||
    !ownedRunIds.includes(activeRunId) ||
    typeof portsValue !== "object" ||
    portsValue === null ||
    Array.isArray(portsValue)
  ) {
    throw new Error("The Nexus test runtime record does not own this repository.");
  }

  const rawPorts = portsValue as Record<string, unknown>;
  const ports = Object.fromEntries(
    PORT_KEYS.map((key) => {
      const port = rawPorts[key];
      if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
        throw new Error(`The Nexus test runtime has an invalid ${key} port.`);
      }
      return [key, Number(port)];
    }),
  ) as Record<PortKey, number>;
  if (new Set(Object.values(ports)).size !== PORT_KEYS.length) {
    throw new Error("The Nexus test runtime ports must be distinct.");
  }

  return {
    version: 2,
    repo_id: repoId,
    compose_project: `nexus-test-${repoId}`,
    supabase_workdir: path.join(repoRoot, ".nexus-test", "supabase"),
    ports,
    owned_run_ids: [...ownedRunIds],
  };
}

export function loadBrowserRuntime(): BrowserRuntime {
  if (process.env.NEXUS_ENV !== "test") {
    throw new Error("Playwright requires NEXUS_ENV=test.");
  }
  const repoRoot = realpathSync(path.resolve(__dirname, "../../.."));
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(path.join(repoRoot, ".nexus-test", "runtime.json"), "utf8"),
    );
  } catch (error) {
    throw new Error(
      "Playwright requires the recorded local Nexus test runtime.",
      { cause: error },
    );
  }
  const runtime = parseRuntimeRecord(parsed, repoRoot);
  const origin = (port: number) => `http://127.0.0.1:${port}`;
  const browserOrigins = new Set([
    origin(runtime.ports.web),
    origin(runtime.ports.api),
    origin(runtime.ports.minio),
    origin(runtime.ports.supabase_api),
    origin(runtime.ports.external),
  ]);
  return {
    repoRoot,
    webOrigin: origin(runtime.ports.web),
    apiOrigin: origin(runtime.ports.api),
    minioOrigin: origin(runtime.ports.minio),
    supabaseOrigin: origin(runtime.ports.supabase_api),
    externalOrigin: origin(runtime.ports.external),
    browserOrigins,
  };
}
