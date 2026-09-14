import { cookies } from "next/headers";

export type AppTheme = "light" | "dark";

export async function readThemeCookie(): Promise<AppTheme | null> {
  const value = (await cookies()).get("nx-theme")?.value;
  return value === "light" || value === "dark" ? value : null;
}
