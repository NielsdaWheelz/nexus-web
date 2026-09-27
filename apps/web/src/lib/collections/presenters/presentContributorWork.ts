import { absent, present } from "@/lib/api/presence";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import type { ContributorWorkItem } from "@/lib/contributors/types";
import {
  contributorRoleLabel,
  normalizeContributorRoleToken,
} from "@/lib/contributors/vocab";

export function presentContributorWork(work: ContributorWorkItem): CollectionRowView {
  if (work.kind === "Media") {
    return presentMedia(work.mediaSummary, {
      id: work.actionSubject.ref,
      primary: { kind: "link", href: work.href, viewTransition: "media-reader" },
      actionSubject: work.actionSubject,
      selected: false,
    });
  }

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
    primary: { kind: "link", href: work.href, paneLabelHint: work.title },
    title: { text: work.title },
    contributors: [],
    publicationDate: work.date,
    context: context.length === 0
      ? absent()
      : present({ kind: "Text", text: context }),
    activity: absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    actionSubject: work.actionSubject,
    selected: false,
  };
}
