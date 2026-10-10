import { firstParam, parseReturnTarget } from "@/lib/auth/urls";
import SessionRecovery from "./SessionRecovery";

export const dynamic = "force-dynamic";

export default async function SessionRecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const nextPath = parseReturnTarget(firstParam((await searchParams).next));
  return <SessionRecovery nextPath={nextPath} />;
}
