"use client";

import MediaActions from "@/components/media/MediaActions";
import PodcastActions from "@/components/podcasts/PodcastActions";
import type { ResourceActionSubject } from "@/lib/actions/inlineActions";
import { assertNever } from "@/lib/assertNever";

/** The finite subject union keeps media and podcast command owners distinct. */
export default function ResourceActions({ subject, ...props }: {
  readonly subject: ResourceActionSubject;
  readonly density: "Row" | "Header";
  readonly returnFocus: () => HTMLElement | null;
  readonly afterRemoval: () => HTMLElement | null;
}) {
  switch (subject.kind) {
    case "Media": return <MediaActions subject={subject.subject} knownDescriptor={subject.knownDescriptor} {...props} />;
    case "Podcast": return <PodcastActions subject={subject.subject} {...props} />;
    default: return assertNever(subject, "unsupported action subject");
  }
}
