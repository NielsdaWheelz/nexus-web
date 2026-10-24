"use client";

import type { MetadataSubject } from "@/lib/actions/subjects";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { projectPodcastDiscoveryActions } from "@/lib/actions/project";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ComponentProps } from "react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import type { PodcastActionFocus, PodcastActionSubject } from "@/lib/actions/inlineActions";
import { usePodcastMenuActions } from "@/lib/actions/usePodcastActions";

/** Discovery has current supplied facts; canonical menus retain their prepared read. */
export default function PodcastMenu({ subject, metadataSubject, actionFocus, sections = [], ...props }: Omit<
  ComponentProps<typeof ContextualActionMenu>, "title" | "resourceRef" | "actionFocus" | "sections"
> & {
  readonly subject: PodcastActionSubject;
  readonly metadataSubject?: Extract<MetadataSubject, { kind: "DiscoveryPodcast" | "DiscoveryPodcastPreview" }>;
  readonly actionFocus: PodcastActionFocus;
  readonly sections?: ComponentProps<typeof ContextualActionMenu>["sections"];
}) {
  const { ctx, run } = useActionRuntime();
  const commands = usePodcastMenuActions(subject, actionFocus);
  if (subject.facts.kind === "Ready" && subject.facts.resolution.kind === "Canonical") return <ContextualActionMenu {...props} title={subject.title}
    sections={sections} actionFocus={actionFocus} resourceRef={canonicalResourceRef({ scheme: "podcast", id: subject.facts.resolution.podcast_id })} />;
  const actions = [...commands, ...(metadataSubject ? projectPodcastDiscoveryActions({ subject: metadataSubject, ctx, run, returnFocus: props.returnFocusTo ?? actionFocus.returnFocus }) : [])];
  const hasView = sections.some(section => section.id === "View");
  return <ContextualActionMenu {...props} title={subject.title}
    sections={hasView ? sections.map(section => section.id === "View" ? { ...section, actions: [...section.actions, ...actions] } : section)
      : [...sections, { id: "View", actions }]} />;
}
