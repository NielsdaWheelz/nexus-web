/** Remote presentation facts shared by desktop admission and the mounted title owner.
 * Authored titles remain local; captures require the authored upload barrier. */
import { apiFetch } from "@/lib/api/client";
import type { ServerReadSeed } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { panePresentationLocatorKey, type PanePresentationLocator } from "@/lib/panes/paneRouteModel";

export type PresentationFacts = Map<string, Schema<"WorkspacePresentationOut"> | null>;
export type InitialPresentations =
  | { readonly status: "success"; readonly data: PresentationFacts }
  | Extract<ServerReadSeed<PresentationFacts>, { status: "failure" }>;

export function authoredPresentation(locator: PanePresentationLocator): boolean {
  return locator.kind === "resource_ref" && /^(page|note_block|highlight):/u.test(locator.ref);
}
export function remotePresentation(locator: PanePresentationLocator): boolean {
  return !authoredPresentation(locator) && locator.kind !== "x_capture";
}
export async function readPresentationFacts(locators: readonly PanePresentationLocator[], signal: AbortSignal, accountId: string): Promise<PresentationFacts> {
  const items: ApiJson<"/me/workspace-presentations", "post">["data"]["items"] = [];
  for (let offset = 0; offset < locators.length; offset += 100) {
    const result = await apiFetch<ApiJson<"/me/workspace-presentations", "post">>("/api/me/workspace-presentations", {
      method: "POST", body: JSON.stringify({ locators: locators.slice(offset, offset + 100) }), signal,
      headers: { "X-Nexus-Account": accountId },
    });
    items.push(...result.data.items);
  }
  return new Map(items.map(item => [panePresentationLocatorKey(item.locator), item.presentation]));
}
