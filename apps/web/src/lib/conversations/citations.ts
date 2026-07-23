// The CitationOut → ReaderCitationData adapter lives in the resource-graph
// citation owner (spec §12); re-exported so existing importers of this module
// (DossierSurface, AssistantEvidenceDisclosure) keep one import path.
// Messages now carry a backend-built `citations: CitationOut[]` (from citation
// edges); there is no frontend reconstruction.
export { toReaderCitationData } from "@/lib/resourceGraph/citations";
