"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Schema } from "@/lib/api/wire";

type ReaderProfile = Readonly<Schema<"ReaderProfileOut">>;
const ReaderProfileContext = createContext<ReaderProfile | null>(null);

/** Hosts supply their actual typography without granting settings mutation. */
export function ReaderProfileProvider({ profile, children }: { readonly profile: ReaderProfile; readonly children: ReactNode }) {
  return <ReaderProfileContext.Provider value={profile}>{children}</ReaderProfileContext.Provider>;
}

export function useReaderProfile(): ReaderProfile {
  const profile = useContext(ReaderProfileContext);
  if (profile === null) throw new Error("reader typography requires a ReaderProfileProvider");
  return profile;
}
