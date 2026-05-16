/**
 * Deterministic seed script for E2E test user.
 * Safe to rerun locally and in CI.
 *
 * Uses Supabase admin API to create/ensure a test user exists.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyResolvedSupabaseEnv } from "./supabase-env.mjs";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SEED_USER_FILE = path.join(ROOT_DIR, "e2e/.seed/e2e-user.json");
applyResolvedSupabaseEnv(ROOT_DIR, process.env, { includeAdminKey: true });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_AUTH_ADMIN_KEY = process.env.SUPABASE_AUTH_ADMIN_KEY;

const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? "e2e-test@nexus.local";
const USERS_PER_PAGE = 200;
const MAX_LIST_PAGES = 25;

interface AdminUser {
  id?: string;
  email?: string | null;
}

interface AdminListUsersResponse {
  users?: AdminUser[];
}

if (!SUPABASE_URL || !SUPABASE_AUTH_ADMIN_KEY) {
  throw new Error(
    "Missing Supabase admin configuration. Expected live values from `supabase status` " +
      "or SUPABASE_URL plus command-scoped SUPABASE_AUTH_ADMIN_KEY.",
  );
}

const authAdminHeaders = {
  Authorization: `Bearer ${SUPABASE_AUTH_ADMIN_KEY}`,
  apikey: SUPABASE_AUTH_ADMIN_KEY,
};

async function findExistingUserByEmail(): Promise<AdminUser | null> {
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const listRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${USERS_PER_PAGE}`,
      {
        headers: authAdminHeaders,
      },
    );

    if (!listRes.ok) {
      throw new Error(
        `Failed to list users: ${listRes.status} ${await listRes.text()}`,
      );
    }

    const payload = (await listRes.json()) as AdminListUsersResponse;
    const users = Array.isArray(payload.users) ? payload.users : [];
    const existing = users.find((user) => user.email === E2E_USER_EMAIL);
    if (existing) {
      return existing;
    }

    if (users.length < USERS_PER_PAGE) {
      break;
    }
  }

  return null;
}

async function seedUser() {
  console.log("Seeding E2E test user...");

  const existing = await findExistingUserByEmail();
  if (existing) {
    console.log(`E2E user already exists (id: ${existing.id})`);
    writeSeedUser(existing);
    return;
  }

  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      ...authAdminHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: E2E_USER_EMAIL,
      email_confirm: true,
    }),
  });

  if (!createRes.ok) {
    const errorBody = await createRes.text();
    if (
      (createRes.status === 409 || createRes.status === 422) &&
      /(already|exists|duplicate)/i.test(errorBody)
    ) {
      const raced = await findExistingUserByEmail();
      if (!raced) {
        throw new Error("E2E user create raced, but the user could not be listed.");
      }
      console.log(
        "E2E user already exists (create raced with another setup run).",
      );
      writeSeedUser(raced);
      return;
    }

    throw new Error(`Failed to create user: ${createRes.status} ${errorBody}`);
  }

  const created = (await createRes.json()) as AdminUser;
  console.log(`E2E user created (id: ${created.id ?? "unknown"})`);
  writeSeedUser(created);
}

function writeSeedUser(user: AdminUser) {
  if (!user.id) {
    throw new Error("E2E user seed did not return a user id.");
  }
  mkdirSync(path.dirname(SEED_USER_FILE), { recursive: true });
  writeFileSync(
    SEED_USER_FILE,
    `${JSON.stringify({ user_id: user.id, email: E2E_USER_EMAIL }, null, 2)}\n`,
    "utf-8",
  );
}

seedUser().catch((err) => {
  console.error(err);
  process.exit(1);
});
