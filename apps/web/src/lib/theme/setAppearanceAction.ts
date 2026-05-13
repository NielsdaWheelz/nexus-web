"use server";

import { cookies } from "next/headers";
import type { AppTheme } from "./cookie";

export async function setAppearanceAction(value: AppTheme | "system") {
  const store = await cookies();
  if (value === "system") {
    store.delete("nx-theme");
    return;
  }
  store.set("nx-theme", value, {
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
