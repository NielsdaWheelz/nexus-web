import { activateResource } from "@/lib/resources/activation";
import type { LibraryPlacementOpenOptions } from "@/lib/libraries/placementController";
import type { LibraryPlacementTarget } from "@/lib/libraries/libraryPlacement";
import { startResourceContextChat } from "@/lib/resources/resourceContextChat";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resourceShareTarget } from "@/lib/sharing/targets";
import type {
  CanonicalResourceRef,
  ShareOpenOptions,
  ShareTarget,
} from "@/lib/sharing/types";

type ActivateResourceOptions = Parameters<typeof activateResource>[1];
type ResourceNavigation = ActivateResourceOptions & {
  readonly navigate: NonNullable<ActivateResourceOptions["navigate"]>;
};
type OpenShare = (target: ShareTarget, options: ShareOpenOptions) => void;
type OpenLibraryPlacement = (
  target: LibraryPlacementTarget,
  options: LibraryPlacementOpenOptions,
) => void;
type OpenConversation = (conversationId: string) => void | Promise<void>;
const resourceChatsInFlight = new Set<CanonicalResourceRef>();

export function executeResourceOpen(input: {
  readonly target: ResourceActionSubject;
  readonly resourceNavigation: ResourceNavigation;
}): void {
  activateResource(input.target.activation, input.resourceNavigation);
}

export function executeResourceShare({
  subject,
  openShare,
  options,
}: {
  readonly subject: ResourceActionSubject;
  readonly openShare: OpenShare;
  readonly options: ShareOpenOptions;
}): void {
  openShare(resourceShareTarget(subject.ref), options);
}

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
  if (
    !ref ||
    subject.activation.resourceRef !== subject.ref ||
    subject.missing
  ) {
    // justify-defect: the relationship action can execute only for one
    // canonical, present subject.
    throw new Error("Invalid library placement resource target");
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
    const conversationId = await startResourceContextChat(ref);
    await openConversation(conversationId);
  } finally {
    resourceChatsInFlight.delete(ref);
  }
}
