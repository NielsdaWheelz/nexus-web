/**
 * Deterministic seed script for E2E test user.
 * Safe to rerun locally and in CI.
 *
 * Uses Supabase admin API to create/ensure a test user exists.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyResolvedSupabaseEnv } from "./supabase-env.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
applyResolvedSupabaseEnv(ROOT_DIR, process.env);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ADMIN_KEY =
  process.env.SUPABASE_ADMIN_KEY ??
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_KEY;

const E2E_USER_EMAIL = "e2e-test@nexus.local";
const USERS_PER_PAGE = 200;
const MAX_LIST_PAGES = 25;

interface AdminUser {
  id?: string;
  email?: string | null;
}

interface AdminListUsersResponse {
  users?: AdminUser[];
}

if (!SUPABASE_URL || !SUPABASE_ADMIN_KEY) {
  throw new Error(
    "Missing Supabase admin configuration. Expected live values from `supabase status` " +
      "or SUPABASE_URL plus SUPABASE_ADMIN_KEY/SUPABASE_SECRET_KEY."
  );
}

const authAdminHeaders = {
  Authorization: `Bearer ${SUPABASE_ADMIN_KEY}`,
  apikey: SUPABASE_ADMIN_KEY,
};

async function findExistingUserByEmail(): Promise<AdminUser | null> {
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const listRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${USERS_PER_PAGE}`,
      {
        headers: authAdminHeaders,
      }
    );

    if (!listRes.ok) {
      throw new Error(`Failed to list users: ${listRes.status} ${await listRes.text()}`);
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
      console.log("E2E user already exists (create raced with another setup run).");
      return;
    }

    throw new Error(`Failed to create user: ${createRes.status} ${errorBody}`);
  }

  const created = (await createRes.json()) as AdminUser;
  console.log(`E2E user created (id: ${created.id ?? "unknown"})`);
}

seedUser().catch((err) => {
  console.error(err);
  process.exit(1);
});
