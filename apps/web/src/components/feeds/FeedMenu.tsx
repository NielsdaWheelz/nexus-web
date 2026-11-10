"use client";

import type { MetadataSubject } from "@/lib/actions/subjects";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { projectPodcastDiscoveryActions } from "@/lib/actions/project";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ComponentProps } from "react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import type { FeedActionFocus, FeedActionSubject } from "@/lib/actions/inlineActions";
import { useFeedMenuActions } from "@/lib/actions/useFeedActions";

/** Discovery has current supplied facts; canonical menus retain their prepared read. */
export default function FeedMenu({ subject, metadataSubject, actionFocus, sections = [], ...props }: Omit<
  ComponentProps<typeof ContextualActionMenu>, "title" | "resourceRef" | "actionFocus" | "sections" | "navigation"
> & {
  readonly subject: FeedActionSubject;
  readonly metadataSubject?: Extract<MetadataSubject, { kind: "DiscoveryPodcast" | "DiscoveryPodcastPreview" }>;
  readonly actionFocus: FeedActionFocus;
  readonly sections?: ComponentProps<typeof ContextualActionMenu>["sections"];
}) {
  const { ctx, run } = useActionRuntime();
  const commands = useFeedMenuActions(subject, actionFocus);
  if (subject.facts.kind === "Ready" && subject.facts.resolution.kind === "Canonical") return <ContextualActionMenu {...props} navigation={null} title={subject.title}
    sections={sections} actionFocus={actionFocus} resourceRef={canonicalResourceRef({ scheme: subject.facts.resolution.feed_kind === "podcast" ? "podcast" : "feed", id: subject.facts.resolution.feed_id })} />;
  const actions = [...commands, ...(metadataSubject ? projectPodcastDiscoveryActions({ subject: metadataSubject, ctx, run, returnFocus: props.returnFocusTo ?? actionFocus.returnFocus }) : [])];
  const hasView = sections.some(section => section.id === "View");
  return <ContextualActionMenu {...props} navigation={null} title={subject.title}
    sections={hasView ? sections.map(section => section.id === "View" ? { ...section, actions: [...section.actions, ...actions] } : section)
      : [...sections, { id: "View", actions }]} />;
}
