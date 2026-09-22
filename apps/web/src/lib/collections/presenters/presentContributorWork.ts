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
import {
  contributorRoleLabel,
  normalizeContributorRoleToken,
} from "@/lib/contributors/vocab";

function primaryForWork(work: ContributorWorkItem): ResourceRowPrimary {
  return {
    kind: "link",
    href: work.href,
    paneLabelHint: work.title,
  };
}

export function presentContributorWork(work: ContributorWorkItem): CollectionRowView {
  const roleContext = [
    ...new Set(
      work.roleFacts.map((fact) =>
        contributorRoleLabel(normalizeContributorRoleToken(fact.role), 1),
      ),
    ),
  ].join(" · ");
  const context = [
    roleContext,
    work.date.kind === "Absent" ? "Publication date unknown" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    id: work.actionSubject?.ref ?? work.href,
    kind: "contributor_work",
    primary: primaryForWork(work),
    title: { text: work.title },
    contributors: [],
    publicationDate: work.date,
    context:
      context.length === 0
        ? absent()
        : present({ kind: "Text", text: context }),
    activity: absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    // External works are a plain link with no resource menu; resource works get
    // the canonical dropdown resolved from their server snapshot.
    actionSubject: work.actionSubject,
    selected: false,
  };
}
