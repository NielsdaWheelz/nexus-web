import type { CookieOptions } from "@supabase/ssr";

export interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}
