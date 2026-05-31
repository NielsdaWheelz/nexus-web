import { callFastAPI } from "@/lib/api/server";
import OracleReadingPaneBody, { type ReadingDetail } from "./OracleReadingPaneBody";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ readingId: string }>;

async function fetchInitialReading(readingId: string): Promise<ReadingDetail | null> {
  try {
    const body = await callFastAPI<{ data?: ReadingDetail }>(
      `/oracle/readings/${encodeURIComponent(readingId)}`,
    );
    return body.data ?? null;
  } catch {
    return null;
  }
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
