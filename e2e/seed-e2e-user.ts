/**
 * Deterministic seed script for E2E test user.
 * Safe to rerun locally and in CI.
 *
 * Uses Supabase admin API to create/ensure a test user exists.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://localhost:54321";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const E2E_USER_EMAIL = "e2e-test@nexus.local";
const E2E_USER_PASSWORD = "e2e-test-password-123!";

async function seedUser() {
  console.log("Seeding E2E test user...");

  const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
    },
  });

  if (!listRes.ok) {
    throw new Error(`Failed to list users: ${listRes.status} ${await listRes.text()}`);
  }

  const { users } = await listRes.json();
  const existing = users.find((u: { email: string }) => u.email === E2E_USER_EMAIL);

  if (existing) {
    console.log(`E2E user already exists (id: ${existing.id})`);
    return;
  }

  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: E2E_USER_EMAIL,
      password: E2E_USER_PASSWORD,
      email_confirm: true,
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create user: ${createRes.status} ${await createRes.text()}`);
  }

  const created = await createRes.json();
  console.log(`E2E user created (id: ${created.id})`);
}

seedUser().catch((err) => {
  console.error(err);
  process.exit(1);
});
