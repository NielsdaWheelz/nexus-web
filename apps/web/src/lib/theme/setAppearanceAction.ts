"use server";

import { cookies } from "next/headers";
import { isDeployed } from "@/lib/env";
import type { AppTheme } from "./cookie";

export async function setAppearanceAction(value: AppTheme) {
  const store = await cookies();
  store.set("nx-theme", value, {
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
    sameSite: "lax",
    secure: isDeployed(),
  });
}
