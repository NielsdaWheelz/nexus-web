import {
  getFirstSearchParamValue,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import SessionRecovery from "./SessionRecovery";

export const dynamic = "force-dynamic";

export default async function SessionRecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const nextPath = parseAuthReturnTarget(
    getFirstSearchParamValue(params.next),
  );

  return <SessionRecovery nextPath={nextPath} />;
}
