/**
 * Search-result presenter — maps the already-presenter-shaped search row
 * view-model onto a `CollectionRowView`. Pure data: no React, no fetch.
 *
 * The view-model is built upstream (`@/lib/search/types`), so this is mostly a
 * re-shape: derive the activation href the same way the old `SearchResultRow`
 * adapter did, the lead icon from the resource-ref scheme, and pass the snippet
 * `<mark>` segments through structurally (CollectionRow renders the emphasis).
 */

import type { CollectionRowView, SignalFact } from "@/lib/collections/types";
import { hrefForResourceActivation } from "@/lib/resources/activation";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import type { SearchResultRowViewModel } from "@/lib/search/types";

export function presentSearchResult(vm: SearchResultRowViewModel): CollectionRowView {
  const href = hrefForResourceActivation(vm.activation);
  if (!href) {
    throw new Error("Search result missing activation href");
  }

  const signals: SignalFact[] = [{ value: vm.typeLabel }];
  if (vm.sourceMeta) signals.push({ value: vm.sourceMeta });

  return {
    id: vm.key,
    kind: "search_result",
    primary: {
      kind: "link",
      href,
      paneTitleHint: vm.paneTitleHint,
      viewTransition: href.startsWith("/media/") ? "media-reader" : undefined,
    },
    lead: { icon: resourceIconForUri(vm.resourceRef) },
    headline: {
      text: vm.primaryText,
      segments: vm.snippetSegments.map((s) => ({ text: s.text, emphasized: s.emphasized })),
    },
    signals: signals.slice(0, 3),
    contributors:
      vm.contributorCredits.length > 0
        ? { credits: vm.contributorCredits, maxVisible: 2, showRole: true }
        : undefined,
  };
}
