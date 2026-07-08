import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q =
    typeof params.q === "string" && params.q.trim() ? params.q.trim() : null;
  const dest = q
    ? `/?launcher=1&lane=browse&q=${encodeURIComponent(q)}`
    : "/?launcher=1&lane=browse";
  permanentRedirect(dest);
}
