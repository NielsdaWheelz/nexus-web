import { cookies } from "next/headers";
import { parseRoom, THEME_COOKIE, type AppTheme } from "./room";

export async function readThemeCookie(): Promise<AppTheme> {
  return parseRoom((await cookies()).get(THEME_COOKIE)?.value);
}
