import { cookies } from "next/headers";

export type AppTheme = "light" | "dark" | "elvish";

// Dark is the default room: the cookie only has to name Study or Solar.
export async function readThemeCookie(): Promise<AppTheme> {
  const value = (await cookies()).get("nx-theme")?.value;
  return value === "light" || value === "elvish" ? value : "dark";
}
