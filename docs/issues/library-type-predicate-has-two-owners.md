# library type predicate has two owners

library type filters the loaded collection in the browser, while playback queue capture applies the same criterion on the server. the read endpoint deliberately does not accept entry_type.

evidence: apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx filters shown entries; python/nexus/services/library_listing.py applies EntryView.entry_type for capture through playback_snapshot.py. both must classify the same media kind; text_part is intentionally not a type choice.

impact: a future kind change could make displayed rows and captured queue membership disagree. keep additions paired at these owners. resolve when one shared classification contract determines both predicates, verified by comparing visible library rows and captured queue membership for every offered type.
