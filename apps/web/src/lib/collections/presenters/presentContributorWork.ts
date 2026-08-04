/**
 * Contributor-work presenter. The compact contributor endpoint owns only a
 * title, destination, partial date, open-ended content kind, and the page
 * contributor's role facts. Canonical row anatomy must not fabricate richer
 * media, podcast, activity, connection, or action capabilities from that data.
 */

import { absent, present } from "@/lib/api/presence";
import type {
  CollectionRowView,
  ResourceRowPrimary,
} from "@/lib/collections/types";
import type { ContributorWorkItem } from "@/lib/contributors/types";
import { hrefForResourceActivation } from "@/lib/resources/activation";

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

function primaryForWork(work: ContributorWorkItem): ResourceRowPrimary {
  const target = work.actionTarget;
  if (target.kind === "External") {
    return {
      kind: "link",
      href: target.href,
      paneLabelHint: work.title,
    };
  }
  const href = hrefForResourceActivation(target.activation);
  if (target.missing || href === null) {
    return { kind: "static" };
  }
  return {
    kind: "link",
    href,
    paneLabelHint: work.title,
    resourceActivation: target.activation,
  };
}

export function presentContributorWork(work: ContributorWorkItem): CollectionRowView {
  const roleContext = [
    ...new Set(work.roleFacts.map((fact) => roleFactLabel(fact.role))),
  ].join(" · ");

  return {
    id:
      work.actionTarget.kind === "Resource"
        ? work.actionTarget.ref
        : work.actionTarget.href,
    kind: "contributor_work",
    primary: primaryForWork(work),
    title: { text: work.title },
    contributors: [],
    publicationDate: work.date,
    context:
      roleContext.length === 0
        ? absent()
        : present({ kind: "Text", text: roleContext }),
    activity: absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    // External works are a plain link with no resource menu; resource works get
    // the canonical dropdown resolved from their server snapshot.
    resourceTarget:
      work.actionTarget.kind === "Resource" ? work.actionTarget : null,
    selected: false,
  };
}
