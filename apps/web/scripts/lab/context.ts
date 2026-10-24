// the runtime publishes this private contract only after service and browser
// readiness. cases own their scenario data and any reset between repetitions.
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface LabContext {
  run_id: string;
  worktree: string;
  web_origin: string;
  web_tls: { ca_file: string; leaf_spki_sha256: string };
  api_origin: string;
  auth_origin: string;
  auth_anon_key: string;
  auth_admin_key_file: string;
  database_url: string;
  storage: {
    origin: string;
    bucket: string;
    region: string;
    access_key_id: string;
    secret_access_key: string;
  };
  wire_revision: number;
  seed: {
    user_id: string;
    default_library_id: string;
    email: string;
    password: string;
  };
  browser_state_file: string;
  artifacts_dir: string;
  fake_providers: { origin: string; ca_file: string } | null;
  client_cpu_throttle: number | null;
}

export function readLabContext(): LabContext {
  const path = process.env.NEXUS_LAB_CONTEXT;
  if (!path || !isAbsolute(path))
    throw new Error("lab requires an absolute nexus_lab_context path");
  // justify-type-assertion: the runtime owns and writes this private same-system
  // contract after readiness; this reader does not accept arbitrary caller data.
  return JSON.parse(readFileSync(path, "utf8")) as LabContext;
}
