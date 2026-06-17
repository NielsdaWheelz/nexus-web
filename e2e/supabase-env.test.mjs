import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import supabaseEnv from "./supabase-env.cjs";

const {
  buildE2eAppRuntimeEnv,
  loadRootFileEnv,
  requireSupabaseAdminEnv,
  resolveSupabaseE2EEnv,
} = supabaseEnv;

const MODULE_PATH = fileURLToPath(new URL("./supabase-env.cjs", import.meta.url));

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "nexus-e2e-supabase-env-"));
  mkdirSync(path.join(root, "supabase"), { recursive: true });
  writeFileSync(
    path.join(root, "supabase/config.toml"),
    '[api]\nport = 54321\n',
    "utf-8",
  );
  return root;
}

function fakeSupabaseBin(statusText, recordPath = null) {
  const binDir = mkdtempSync(path.join(tmpdir(), "nexus-fake-supabase-"));
  const supabasePath = path.join(binDir, "supabase");
  const recordCommand = recordPath
    ? `{
  printf 'cwd=%s\\n' "$PWD"
  printf 'arg=%s\\n' "$@"
} > ${JSON.stringify(recordPath)}
`
    : "";
  writeFileSync(
    supabasePath,
    `#!/usr/bin/env bash
if [ "$#" = "5" ] && [ "$1" = "--workdir" ] && [ "$3" = "status" ] && [ "$4" = "--output" ] && [ "$5" = "json" ]; then
${recordCommand}
cat <<'JSON'
${statusText}
JSON
else
  exit 2
fi
`,
    "utf-8",
  );
  chmodSync(supabasePath, 0o755);
  return binDir;
}

function withPath(pathValue, fn) {
  const original = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = original;
    }
  }
}

test("requires admin from local Supabase status SECRET_KEY", () => {
  const root = makeRoot();
  const binDir = fakeSupabaseBin(
    'Stopped services: imgproxy\n{"API_URL":"http://127.0.0.1:54321","ANON_KEY":"anon-key","SECRET_KEY":"secret-key"}',
  );
  const env = {};

  withPath(`${binDir}${path.delimiter}${process.env.PATH ?? ""}`, () => {
    const resolved = requireSupabaseAdminEnv(root, env, { loadFiles: false });

    assert.deepEqual(resolved, {
      supabaseUrl: "http://127.0.0.1:54321",
      anonKey: "anon-key",
      adminKey: "secret-key",
    });
    assert.equal(env.SUPABASE_AUTH_ADMIN_KEY, "secret-key");
    assert.equal(env.SUPABASE_ISSUER, "http://127.0.0.1:54321/auth/v1");
  });
});

test("does not accept SERVICE_ROLE_KEY from local Supabase status", () => {
  const root = makeRoot();
  const binDir = fakeSupabaseBin(
    '{"API_URL":"http://127.0.0.1:54321","ANON_KEY":"anon-key","SERVICE_ROLE_KEY":"legacy-key"}',
  );

  withPath(`${binDir}${path.delimiter}${process.env.PATH ?? ""}`, () => {
    assert.throws(
      () => requireSupabaseAdminEnv(root, {}, { loadFiles: false }),
      /SUPABASE_AUTH_ADMIN_KEY/,
    );
  });
});

test("uses complete explicit command env when Supabase CLI is unavailable", () => {
  const root = makeRoot();
  const emptyPath = mkdtempSync(path.join(tmpdir(), "nexus-empty-path-"));

  withPath(emptyPath, () => {
    const resolved = requireSupabaseAdminEnv(
      root,
      {
        SUPABASE_URL: "http://localhost:54321",
        SUPABASE_ANON_KEY: "anon-key",
        SUPABASE_AUTH_ADMIN_KEY: "secret-key",
      },
      { loadFiles: false },
    );

    assert.equal(resolved.supabaseUrl, "http://localhost:54321");
    assert.equal(resolved.anonKey, "anon-key");
    assert.equal(resolved.adminKey, "secret-key");
  });
});

test("uses SUPABASE_WORKDIR for config fallback", () => {
  const root = makeRoot();
  writeFileSync(
    path.join(root, ".env"),
    "SUPABASE_URL=http://127.0.0.1:54321\n",
    "utf-8",
  );
  const supabaseWorkdir = makeRoot();
  writeFileSync(
    path.join(supabaseWorkdir, "supabase/config.toml"),
    '[api]\nport = 54331\n',
    "utf-8",
  );
  const emptyPath = mkdtempSync(path.join(tmpdir(), "nexus-empty-path-"));

  withPath(emptyPath, () => {
    const resolved = resolveSupabaseE2EEnv(
      root,
      {
        SUPABASE_WORKDIR: supabaseWorkdir,
        SUPABASE_ANON_KEY: "anon-key",
      },
    );

    assert.equal(resolved.supabaseUrl, "http://127.0.0.1:54331");
    assert.equal(resolved.anonKey, "anon-key");
  });
});

test("prints shell exports through the resolver CLI using SUPABASE_WORKDIR", () => {
  const supabaseWorkdir = makeRoot();
  const recordPath = path.join(
    mkdtempSync(path.join(tmpdir(), "nexus-fake-supabase-record-")),
    "call.txt",
  );
  const binDir = fakeSupabaseBin(
    '{"API_URL":"http://127.0.0.1:55421","PUBLISHABLE_KEY":"anon-key","SECRET_KEY":"secret-key"}',
    recordPath,
  );
  const output = execFileSync(
    process.execPath,
    [MODULE_PATH, "--print-shell", "--require-admin"],
    {
      cwd: makeRoot(),
      encoding: "utf-8",
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SUPABASE_WORKDIR: supabaseWorkdir,
      },
    },
  );

  assert.match(output, /export SUPABASE_URL='http:\/\/127\.0\.0\.1:55421'/);
  assert.match(output, /export SUPABASE_ANON_KEY='anon-key'/);
  assert.match(output, /export SUPABASE_AUTH_ADMIN_KEY='secret-key'/);
  assert.deepEqual(readFileSync(recordPath, "utf-8").trim().split("\n"), [
    `cwd=${path.resolve(path.dirname(MODULE_PATH), "..")}`,
    "arg=--workdir",
    `arg=${supabaseWorkdir}`,
    "arg=status",
    "arg=--output",
    "arg=json",
  ]);
});

test("rejects non-local Supabase URLs", () => {
  const root = makeRoot();
  const emptyPath = mkdtempSync(path.join(tmpdir(), "nexus-empty-path-"));

  withPath(emptyPath, () => {
    assert.throws(
      () =>
        resolveSupabaseE2EEnv(
          root,
          {
            SUPABASE_URL: "https://project.supabase.co",
            SUPABASE_ANON_KEY: "anon-key",
          },
          { loadFiles: false },
        ),
      /local-only/,
    );
  });
});

test("rejects legacy admin env aliases", () => {
  const root = makeRoot();
  assert.throws(
    () =>
      resolveSupabaseE2EEnv(
        root,
        {
          SUPABASE_URL: "http://127.0.0.1:54321",
          SUPABASE_ANON_KEY: "anon-key",
          SUPABASE_SERVICE_ROLE_KEY: "legacy-key",
        },
        { loadFiles: false },
      ),
    /SUPABASE_SERVICE_ROLE_KEY/,
  );
});

test("filters persisted admin env out of root env files", () => {
  const root = makeRoot();
  writeFileSync(
    path.join(root, ".env"),
    [
      "SUPABASE_URL=http://127.0.0.1:54321",
      "SUPABASE_ANON_KEY=anon-key",
      "SUPABASE_AUTH_ADMIN_KEY=do-not-load",
      "SUPABASE_SERVICE_ROLE_KEY=do-not-load",
      "",
    ].join("\n"),
    "utf-8",
  );

  const fileEnv = loadRootFileEnv(root);

  assert.equal(fileEnv.SUPABASE_URL, "http://127.0.0.1:54321");
  assert.equal(fileEnv.SUPABASE_ANON_KEY, "anon-key");
  assert.equal(fileEnv.SUPABASE_AUTH_ADMIN_KEY, undefined);
  assert.equal(fileEnv.SUPABASE_SERVICE_ROLE_KEY, undefined);
});

test("scrubs app runtime Supabase admin env", () => {
  const runtimeEnv = buildE2eAppRuntimeEnv({
    E2E_MAILBOX_URL: "http://127.0.0.1:54324",
    SUPABASE_API_PORT: "54321",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_AUTH_ADMIN_KEY: "admin-key",
    SUPABASE_DATABASE_URL: "postgres://supabase",
    SUPABASE_DB_PORT: "54322",
    SUPABASE_DB_SHADOW_PORT: "54325",
    SUPABASE_INBUCKET_PORT: "54324",
    SUPABASE_PROJECT_ID: "nexus-web-test",
    SUPABASE_SERVICE_KEY: "service-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_STUDIO_PORT: "54323",
    SUPABASE_WORKDIR: "/tmp/nexus-supabase",
    SERVICE_ROLE_KEY: "legacy-key",
  });

  assert.equal(runtimeEnv.SUPABASE_URL, "http://127.0.0.1:54321");
  assert.equal(runtimeEnv.E2E_MAILBOX_URL, undefined);
  assert.equal(runtimeEnv.SUPABASE_API_PORT, undefined);
  assert.equal(runtimeEnv.SUPABASE_AUTH_ADMIN_KEY, undefined);
  assert.equal(runtimeEnv.SUPABASE_DATABASE_URL, undefined);
  assert.equal(runtimeEnv.SUPABASE_DB_PORT, undefined);
  assert.equal(runtimeEnv.SUPABASE_DB_SHADOW_PORT, undefined);
  assert.equal(runtimeEnv.SUPABASE_INBUCKET_PORT, undefined);
  assert.equal(runtimeEnv.SUPABASE_PROJECT_ID, undefined);
  assert.equal(runtimeEnv.SUPABASE_SERVICE_KEY, undefined);
  assert.equal(runtimeEnv.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(runtimeEnv.SUPABASE_STUDIO_PORT, undefined);
  assert.equal(runtimeEnv.SUPABASE_WORKDIR, undefined);
  assert.equal(runtimeEnv.SERVICE_ROLE_KEY, undefined);
});

test("prints shell exports through the resolver CLI", () => {
  const root = makeRoot();
  const binDir = fakeSupabaseBin(
    '{"API_URL":"http://127.0.0.1:54321","PUBLISHABLE_KEY":"anon-key","SECRET_KEY":"secret-key"}',
  );
  const output = execFileSync(
    process.execPath,
    [MODULE_PATH, "--print-shell", "--require-admin"],
    {
      cwd: root,
      encoding: "utf-8",
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );

  assert.match(output, /export SUPABASE_URL='http:\/\/127\.0\.0\.1:54321'/);
  assert.match(output, /export SUPABASE_ANON_KEY='anon-key'/);
  assert.match(output, /export SUPABASE_AUTH_ADMIN_KEY='secret-key'/);
  assert.doesNotMatch(output, /SERVICE_ROLE_KEY/);
});
