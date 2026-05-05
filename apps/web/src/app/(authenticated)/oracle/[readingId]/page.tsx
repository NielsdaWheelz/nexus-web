import { headers } from "next/headers";
import OracleReadingPaneBody, { type ReadingDetail } from "./OracleReadingPaneBody";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ readingId: string }>;

async function fetchInitialReading(readingId: string): Promise<ReadingDetail | null> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const cookie = requestHeaders.get("cookie");
  if (!host || !cookie) return null;

  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const response = await fetch(
    `${protocol}://${host}/api/oracle/readings/${encodeURIComponent(readingId)}`,
    {
      headers: {
        accept: "application/json",
        cookie,
      },
      cache: "no-store",
    },
  ).catch(() => null);
  if (response === null || !response.ok) return null;

  const body = (await response.json().catch(() => null)) as
    | { data?: ReadingDetail }
    | null;
  return body?.data ?? null;
}

export default async function OracleReadingPage({ params }: { params: Params }) {
  const { readingId } = await params;
  const initialDetail = await fetchInitialReading(readingId);
  return (
    <OracleReadingPaneBody
      readingId={readingId}
      initialDetail={initialDetail}
    />
  );
}
