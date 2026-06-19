/**
 * Contributor presenters — pure data, no React/fetch. Two surfaces:
 *  - `presentContributor`: a contributor row in the authors directory; an author
 *    leads with presence (work count first), kind/disambiguation are subordinate.
 *  - `presentContributorWork`: a credited-work row on an author's detail page;
 *    a work is a media/document, so it surfaces the same facts `buildWorkMeta`
 *    did (role / credited-as / date / publisher / source) capped to the top few.
 */

import { connectionsFromSummary } from "@/lib/collections/connectionSummary";
import type { CollectionRowView, SignalFact } from "@/lib/collections/types";
import type { ContributorDirectoryEntry, ContributorWork } from "@/lib/contributors/types";
import type { ConnectionSummaryOut } from "@/lib/resourceGraph/connections";
import { formatContributorRole } from "@/lib/contributors/formatting";
import { mediaKindIcon, resourceIconForScheme } from "@/lib/resources/resourceKind";
import { pluralize } from "@/lib/text/pluralize";

const MAX_SIGNALS = 3;

export function presentContributor(entry: ContributorDirectoryEntry): CollectionRowView {
  // Presence first: work count earns the most weight, kind/disambiguation follow.
  const signals: SignalFact[] = [{ value: pluralize(entry.work_count, "work") }];
  if (entry.kind) signals.push({ value: entry.kind });
  if (entry.disambiguation) signals.push({ value: entry.disambiguation });

  return {
    id: entry.handle,
    kind: "contributor",
    primary: { kind: "link", href: entry.href, paneTitleHint: entry.display_name },
    lead: { icon: resourceIconForScheme("contributor") },
    headline: { text: entry.display_name },
    signals: signals.slice(0, MAX_SIGNALS),
  };
}

export function presentContributorWork(
  work: ContributorWork,
  ctx: { connectionSummary?: ConnectionSummaryOut } = {},
): CollectionRowView {
  // Same facts `buildWorkMeta` surfaced, in the same priority order, only when present.
  const signals: SignalFact[] = [];
  const role = formatContributorRole(work.role);
  const creditedName = work.credited_name?.trim();
  if (role) signals.push({ value: role });
  if (creditedName) signals.push({ label: "credited as", value: creditedName });
  if (work.published_date) signals.push({ value: work.published_date });
  if (work.publisher) signals.push({ value: work.publisher });
  if (work.source) signals.push({ value: work.source });

  return {
    id: `${work.object_type}:${work.object_id}`,
    kind: "media",
    primary: { kind: "link", href: work.route, paneTitleHint: work.title },
    lead: { icon: mediaKindIcon(work.content_kind) },
    headline: { text: work.title },
    signals: signals.slice(0, MAX_SIGNALS),
    connections: connectionsFromSummary(ctx.connectionSummary),
  };
}
