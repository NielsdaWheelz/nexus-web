/**
 * Browser-side Supabase client for client components.
 *
 * This client is used in "use client" components for browser-side
 * authentication operations like sign in/sign out.
 *
 * Note: For server-side operations (route handlers, server components),
 * use the server.ts client instead.
 */

import { createBrowserClient } from "@supabase/ssr";

/**
 * Create a Supabase client for browser-side operations.
 *
 * Uses browser storage for session management.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
