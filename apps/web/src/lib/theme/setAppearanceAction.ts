"use server";

import { cookies } from "next/headers";
import { isDeployed } from "@/lib/env";
import { THEME_COOKIE, type AppTheme } from "./room";

export async function setAppearanceAction(value: AppTheme) {
  (await cookies()).set(THEME_COOKIE, value, {
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
    sameSite: "lax",
    secure: isDeployed(),
  });
}
