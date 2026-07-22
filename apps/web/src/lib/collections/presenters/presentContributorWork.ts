/**
 * Contributor-work presenter. The compact contributor endpoint owns only a
 * title, destination, partial date, open-ended content kind, and the page
 * contributor's role facts. Canonical row anatomy must not fabricate richer
 * media, podcast, activity, connection, or action capabilities from that data.
 */

import { absent, present } from "@/lib/api/presence";
import type { CollectionRowView } from "@/lib/collections/types";
import type { ContributorWorkItem } from "@/lib/contributors/types";

// Singular role labels carried over from AuthorPaneBody. One work role-fact is
// one credit, and an unrecognized token keeps the established generic label.
const ROLE_SINGULAR: Readonly<Record<string, string>> = {
  author: "Author",
  editor: "Editor",
  translator: "Translator",
  host: "Host",
  guest: "Guest",
  narrator: "Narrator",
  creator: "Creator",
  producer: "Producer",
  publisher: "Publisher",
  channel: "Channel",
  organization: "Organization",
  unknown: "Contributor",
};

function roleFactLabel(role: string): string {
  return ROLE_SINGULAR[role.trim()] ?? "Contributor";
}

export function presentContributorWork(work: ContributorWorkItem): CollectionRowView {
  const roleContext = [
    ...new Set(work.roleFacts.map((fact) => roleFactLabel(fact.role))),
  ].join(" · ");

  return {
    id: work.href,
    kind: "contributor_work",
    primary: { kind: "link", href: work.href, paneLabelHint: work.title },
    title: { text: work.title },
    contributors: [],
    publicationDate: work.date,
    context:
      roleContext.length === 0
        ? absent()
        : present({ kind: "Text", text: roleContext }),
    activity: absent(),
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actions: [],
    selected: false,
  };
}
