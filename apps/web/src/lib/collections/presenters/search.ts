/** Pure semantic projection for one already-decoded search result row. */

import { absent, present } from "@/lib/api/presence";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import { hrefForResourceActivation } from "@/lib/resources/activation";
import type { SearchResultRowViewModel } from "@/lib/search/types";

export function presentSearchResult(vm: SearchResultRowViewModel): CollectionRowView {
  const href = hrefForResourceActivation(vm.activation);
  if (!href) {
    throw new Error("Search result missing activation href");
  }

  if ("mediaSummary" in vm) {
    const evidence = vm.snippetSegments.length > 0 && (
      vm.snippetSegments.some((segment) => segment.emphasized) ||
      vm.snippetSegments.map((segment) => segment.text).join("") !== vm.mediaSummary.title
    ) ? vm.snippetSegments : undefined;
    return presentMedia(vm.mediaSummary, {
      id: vm.key,
      primary: { kind: "link", href, viewTransition: "media-reader" },
      actionSubject: vm.actionSubject,
      selected: false,
      searchEvidence: evidence,
    });
  }
  const context =
    vm.snippetSegments.length > 0
      ? present({
          kind: "Snippet" as const,
          segments: vm.snippetSegments.map((segment) => ({
            text: segment.text,
            emphasized: segment.emphasized,
          })),
        })
      : present({
          kind: "Text" as const,
          text: [vm.typeLabel, vm.sourceMeta].filter(Boolean).join(" · "),
        });

  return {
    id: vm.key,
    kind: "search_result",
    primary: {
      kind: "link",
      href,
      paneLabelHint: vm.paneLabelHint,
      viewTransition: href.startsWith("/media/") ? "media-reader" : undefined,
    },
    title: { text: vm.primaryText },
    contributors: vm.contributorCredits,
    publicationDate: vm.publicationDate,
    context,
    activity: absent(),
    exceptionalStatus: absent(),
    actionSubject: vm.actionSubject,
    selected: false,
  };
}
