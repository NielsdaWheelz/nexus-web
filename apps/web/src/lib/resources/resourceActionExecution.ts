import { activateResource } from "@/lib/resources/activation";
import { startResourceContextChat } from "@/lib/resources/resourceContextChat";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
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
type OpenConversation = (
  conversationId: string,
) => void | Promise<void>;
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
