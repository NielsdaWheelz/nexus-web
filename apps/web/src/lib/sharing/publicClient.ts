import {
  decodePublicFragmentPage,
  decodePublicNavigationPage,
  decodePublicSection,
  decodePublicShareBootstrap,
  type PublicFragmentPage,
  type PublicNavigationPage,
  type PublicSection,
  type PublicShareBootstrap,
} from "./publicContract";

const SHARE_TOKEN_HEADER = "X-Nexus-Share-Token";

export class PublicShareUnavailable extends Error {
  constructor() {
    super("Share unavailable");
    this.name = "PublicShareUnavailable";
  }
}

export async function readPublicShareBootstrap(
  token: string,
  signal: AbortSignal
): Promise<PublicShareBootstrap> {
  return decodePublicShareBootstrap(
    await fetchJson("/api/public/resource-share", token, signal)
  );
}

export async function readAllPublicFragments(
  token: string,
  signal: AbortSignal
): Promise<PublicFragmentPage> {
  let cursor: string | null = null;
  let result: PublicFragmentPage | null = null;
  do {
    const query = cursor
      ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
      : "?limit=100";
    const page = decodePublicFragmentPage(
      await fetchJson(
        `/api/public/resource-share/fragments${query}`,
        token,
        signal
      )
    );
    if (result === null) {
      result = page;
    } else if (
      result.kind === "ArticleFragments" &&
      page.kind === "ArticleFragments"
    ) {
      result = { ...page, items: [...result.items, ...page.items] };
    } else if (
      result.kind === "TranscriptSegments" &&
      page.kind === "TranscriptSegments"
    ) {
      result = { ...page, items: [...result.items, ...page.items] };
    } else {
      throw new PublicShareUnavailable();
    }
    cursor =
      page.nextCursor.kind === "Present" ? page.nextCursor.value : null;
  } while (cursor !== null);

  if (result === null) {
    throw new PublicShareUnavailable();
  }
  return result;
}

export async function readAllPublicNavigation(
  token: string,
  signal: AbortSignal
): Promise<PublicNavigationPage> {
  let cursor: string | null = null;
  const items: PublicNavigationPage["items"] = [];
  do {
    const query = cursor
      ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
      : "?limit=100";
    const page = decodePublicNavigationPage(
      await fetchJson(
        `/api/public/resource-share/navigation${query}`,
        token,
        signal
      )
    );
    items.push(...page.items);
    cursor =
      page.nextCursor.kind === "Present" ? page.nextCursor.value : null;
  } while (cursor !== null);
  return { items, nextCursor: { kind: "Absent" } };
}

export async function readPublicSection(
  token: string,
  sectionHandle: string,
  signal: AbortSignal
): Promise<PublicSection> {
  return decodePublicSection(
    await fetchJson(
      `/api/public/resource-share/sections/${encodeURIComponent(sectionHandle)}`,
      token,
      signal
    )
  );
}

export async function readPublicAsset(
  token: string,
  assetHandle: string,
  signal: AbortSignal
): Promise<Blob> {
  const response = await publicFetch(
    `/api/public/resource-share/assets/${encodeURIComponent(assetHandle)}`,
    token,
    signal
  );
  if (!response.ok) throw new PublicShareUnavailable();
  return response.blob();
}

export function publicPdfSource(token: string): {
  url: string;
  httpHeaders: Record<string, string>;
  withCredentials: false;
  disableRange: false;
  disableStream: false;
  disableAutoFetch: true;
} {
  return {
    url: "/api/public/resource-share/file",
    httpHeaders: { [SHARE_TOKEN_HEADER]: token },
    withCredentials: false,
    disableRange: false,
    disableStream: false,
    disableAutoFetch: true,
  };
}

async function fetchJson(
  path: string,
  token: string,
  signal: AbortSignal
): Promise<unknown> {
  const response = await publicFetch(path, token, signal);
  if (!response.ok) throw new PublicShareUnavailable();
  return response.json();
}

function publicFetch(
  path: string,
  token: string,
  signal: AbortSignal
): Promise<Response> {
  return fetch(path, {
    method: "GET",
    headers: { [SHARE_TOKEN_HEADER]: token },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal,
  });
}
