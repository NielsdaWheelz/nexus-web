/**
 * Server-side Supabase client for Next.js route handlers and server components.
 *
 * This client uses cookies for session management and should only be used
 * on the server side (route handlers, server components, middleware).
 *
 * Security:
 * - Access tokens are never exposed to the browser
 * - Session is managed via HTTP-only cookies
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}

/**
 * Create a Supabase client for server-side operations.
 *
 * Uses cookies for session management. The access token is extracted
 * from the session for forwarding to FastAPI.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  );
}
