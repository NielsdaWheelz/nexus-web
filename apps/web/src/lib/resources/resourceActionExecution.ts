import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import type { LibraryPlacementOpenOptions } from "@/lib/libraries/placementController";
import type { LibraryPlacementTarget } from "@/lib/libraries/libraryPlacement";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

type OpenLibraryPlacement = (
  target: LibraryPlacementTarget,
  options: LibraryPlacementOpenOptions,
) => void;
type OpenConversation = (conversationId: string) => void | Promise<void>;
const resourceChatsInFlight = new Set<CanonicalResourceRef>();

export function executeResourceLibraryPlacement({
  subject,
  openLibraryPlacement,
  options,
}: {
  readonly subject: ResourceActionSubject;
  readonly openLibraryPlacement: OpenLibraryPlacement;
  readonly options: LibraryPlacementOpenOptions;
}): void {
  const ref = parseResourceRef(subject.ref);
  if (!ref) {
    // justify-defect: the relationship action can execute only for one
    // canonical subject. Presence and applicability are snapshot-owned and the
    // owning placement command reauthorizes before mutation.
    throw new Error("Invalid library placement resource subject");
  }
  switch (ref.scheme) {
    case "media":
      openLibraryPlacement({ kind: "Media", id: ref.id }, options);
      return;
    case "podcast":
      openLibraryPlacement({ kind: "Podcast", id: ref.id }, options);
      return;
    default:
      // justify-defect: only schemes with ManageEntries can publish the
      // placement action.
      throw new Error(`Unsupported library placement scheme: ${ref.scheme}`);
  }
}

export async function executeResourceChat({
  ref,
  openConversation,
}: {
  readonly ref: CanonicalResourceRef;
  readonly openConversation: OpenConversation;
}): Promise<void> {
  if (resourceChatsInFlight.has(ref)) return;
  resourceChatsInFlight.add(ref);
  try {
    const response = await apiFetch<ApiJson<"/conversations", "post">>(
      "/api/conversations",
      {
        method: "POST",
        body: JSON.stringify({ initial_context_refs: [ref] }),
      },
    );
    await openConversation(response.data.id);
  } finally {
    resourceChatsInFlight.delete(ref);
  }
}
