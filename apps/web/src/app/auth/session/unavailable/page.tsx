import type { Metadata } from "next";
import { firstParam, parseReturnTarget } from "@/lib/auth/urls";
import SessionUnavailable from "./SessionUnavailable";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "nexus couldn’t open",
  robots: { index: false, follow: false },
};

export default async function SessionUnavailablePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const nextPath = parseReturnTarget(firstParam((await searchParams).next));
  return <SessionUnavailable nextPath={nextPath} />;
}
