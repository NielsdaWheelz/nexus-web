import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

function fakeSupabaseBin(statusText) {
  const binDir = mkdtempSync(path.join(tmpdir(), "nexus-fake-supabase-"));
  const supabasePath = path.join(binDir, "supabase");
  writeFileSync(
    supabasePath,
    `#!/usr/bin/env bash
if [ "$1" = "status" ] && [ "$2" = "--output" ] && [ "$3" = "json" ]; then
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
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_AUTH_ADMIN_KEY: "admin-key",
    SUPABASE_DATABASE_URL: "postgres://supabase",
    SUPABASE_SERVICE_KEY: "service-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SERVICE_ROLE_KEY: "legacy-key",
  });

  assert.equal(runtimeEnv.SUPABASE_URL, "http://127.0.0.1:54321");
  assert.equal(runtimeEnv.SUPABASE_AUTH_ADMIN_KEY, undefined);
  assert.equal(runtimeEnv.SUPABASE_DATABASE_URL, undefined);
  assert.equal(runtimeEnv.SUPABASE_SERVICE_KEY, undefined);
  assert.equal(runtimeEnv.SUPABASE_SERVICE_ROLE_KEY, undefined);
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
