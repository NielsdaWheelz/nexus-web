"use client";

import type { ComponentProps } from "react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import type { PodcastActionFocus, PodcastActionSubject } from "@/lib/actions/inlineActions";
import { usePodcastMenuActions } from "@/lib/actions/usePodcastActions";

/** Discovery has current supplied facts; canonical menus retain their prepared read. */
export default function PodcastMenu({ subject, actionFocus, sections = [], ...props }: Omit<
  ComponentProps<typeof ContextualActionMenu>, "title" | "resourceRef" | "actionFocus" | "sections"
> & {
  readonly subject: PodcastActionSubject;
  readonly actionFocus: PodcastActionFocus;
  readonly sections?: ComponentProps<typeof ContextualActionMenu>["sections"];
}) {
  const commands = usePodcastMenuActions(subject, actionFocus);
  const hasView = sections.some(section => section.id === "View");
  return <ContextualActionMenu {...props} title={subject.title}
    sections={hasView ? sections.map(section => section.id === "View" ? { ...section, actions: [...section.actions, ...commands] } : section)
      : [...sections, { id: "View", actions: commands }]} />;
}
