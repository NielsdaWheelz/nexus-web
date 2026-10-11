import { BRAND_BG_DARK, BRAND_BG_LIGHT } from "@/lib/brand";

/** The three rooms: Study (light), Press (dark, the default) and the Solar (elvish). */
export type AppTheme = "light" | "dark" | "elvish";

/** `light` | `elvish` | `dark`; absent means the Press. A year, path `/`, Lax. */
export const THEME_COOKIE = "nx-theme";

/** Each room's browser chrome; the Solar's is its --surface-canvas (globals.css). */
export const ROOM_CHROME: Record<AppTheme, string> = {
  light: BRAND_BG_LIGHT,
  dark: BRAND_BG_DARK,
  elvish: "#15201b",
};

export function parseRoom(value: string | undefined): AppTheme {
  return value === "light" || value === "elvish" ? value : "dark";
}
