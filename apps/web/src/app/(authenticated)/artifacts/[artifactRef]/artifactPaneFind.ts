import type {
  DossierDocumentFindCapability,
  DossierDocumentFindScope,
} from "@/components/dossier/DossierDocumentFrame";
import {
  createPaneFindResultKey,
  createPaneFindSourceKey,
  type PaneFindResultKey,
} from "@/lib/panes/paneSearch";
import type { PaneFindAdapter } from "@/lib/panes/usePaneFind";

export type ArtifactPaneFindError = {
  readonly kind: "OriginUnavailable";
};

const ENTIRE_SCOPE_ID = "all";
const CURRENT_SECTION_SCOPE_ID = "current";

export function createArtifactPaneFindAdapter(
  artifactRef: string,
  capability: DossierDocumentFindCapability,
): PaneFindAdapter<ArtifactPaneFindError> {
  const revisionRef = capability.revisionRef;
  const sourceIdentity = {
    kind: "DossierRevision",
    artifactRef,
    revisionRef,
  } as const;
  const sourceKey = createPaneFindSourceKey(sourceIdentity);
  let currentSessionId = 0;
  let currentSectionId: string | null = null;
  let currentQueryId = 0;
  let resultOrdinals = new Map<
    PaneFindResultKey,
    {
      readonly sessionId: number;
      readonly queryId: number;
      readonly ordinal: number;
    }
  >();
  const assertCurrentSource = (
    requestSourceKey: typeof sourceKey,
    operation: string,
  ) => {
    if (
      requestSourceKey !== sourceKey ||
      capability.revisionRef !== revisionRef
    ) {
      throw new Error(`Artifact Find ${operation} source identity is stale.`);
    }
  };
  const assertCurrentSession = (sessionId: number, operation: string) => {
    if (sessionId !== currentSessionId) {
      throw new Error(`Artifact Find ${operation} session is stale.`);
    }
  };

  return {
    sourceKey,
    async prepare(request) {
      assertCurrentSource(request.sourceKey, "prepare");
      currentSessionId = request.sessionId;
      currentSectionId = null;
      currentQueryId = 0;
      resultOrdinals = new Map();
      const prepared = await capability.prepare({
        sessionId: request.sessionId,
        signal: request.signal,
      });
      const preparedSectionId =
        prepared.currentSection.kind === "Present"
          ? prepared.currentSection.value.id
          : null;
      if (currentSessionId === request.sessionId) {
        currentSectionId = preparedSectionId;
      }
      return {
        sessionId: request.sessionId,
        sourceKey: request.sourceKey,
        scopes: [
          {
            kind: "EntireResource",
            id: ENTIRE_SCOPE_ID,
            label: "Entire dossier",
          },
          ...(prepared.currentSection.kind === "Present"
            ? [
                {
                  kind: "Narrow" as const,
                  id: CURRENT_SECTION_SCOPE_ID,
                  label: "This section",
                },
              ]
            : []),
        ],
      };
    },
    async find(request) {
      assertCurrentSource(request.sourceKey, "query");
      assertCurrentSession(request.sessionId, "query");
      const scope: DossierDocumentFindScope =
        request.scopeId === ENTIRE_SCOPE_ID
          ? { kind: "EntireResource" }
          : request.scopeId === CURRENT_SECTION_SCOPE_ID &&
              currentSectionId !== null
            ? { kind: "CurrentSection", sectionId: currentSectionId }
            : (() => {
                throw new Error(
                  `Unknown Artifact Find scope: ${request.scopeId}`,
                );
              })();
      currentQueryId = request.queryId;
      resultOrdinals = new Map();
      const result = await capability.find({
        sessionId: request.sessionId,
        queryId: request.queryId,
        query: request.query,
        scope,
        matchCase: request.matchCase,
        wholeWord: request.wholeWord,
        signal: request.signal,
      });
      const base = {
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
      } as const;
      switch (result.kind) {
        case "NoMatches":
          return {
            ...base,
            kind: "NoMatches",
            completeness: "Complete",
          };
        case "TooManyMatches":
          return {
            ...base,
            kind: "TooManyMatches",
            threshold: result.threshold,
          };
        case "Ready": {
          const nextResultOrdinals = new Map<
            PaneFindResultKey,
            {
              readonly sessionId: number;
              readonly queryId: number;
              readonly ordinal: number;
            }
          >();
          const rows = result.occurrences.map((occurrence) => {
            const key = createPaneFindResultKey({
              source: sourceIdentity,
              locator: {
                kind: "ArtifactRange",
                startCp: occurrence.startCp,
                endCp: occurrence.endCp,
              },
            });
            nextResultOrdinals.set(key, {
              sessionId: request.sessionId,
              queryId: request.queryId,
              ordinal: occurrence.ordinal,
            });
            return {
              key,
              context:
                occurrence.section.kind === "Present"
                  ? [occurrence.section.value.title]
                  : [],
              snippet: occurrence.snippet,
            };
          });
          if (
            currentSessionId === request.sessionId &&
            currentQueryId === request.queryId
          ) {
            resultOrdinals = nextResultOrdinals;
          }
          return {
            ...base,
            kind: "Ready",
            completeness: "Complete",
            rows,
          };
        }
      }
    },
    async preview(request) {
      assertCurrentSource(request.sourceKey, "preview");
      assertCurrentSession(request.sessionId, "preview");
      const target = resultOrdinals.get(request.key);
      if (
        !target ||
        target.sessionId !== request.sessionId ||
        target.queryId !== request.queryId
      ) {
        throw new Error("Artifact Find preview requires a current result key.");
      }
      const activation = await capability.activate({
        sessionId: request.sessionId,
        queryId: request.queryId,
        ordinal: target.ordinal,
        signal: request.signal,
      });
      if (
        activation.kind === "Activated" &&
        activation.ordinal !== target.ordinal
      ) {
        throw new Error("Artifact Find activated the wrong occurrence.");
      }
      return activation.kind === "Activated"
        ? {
            kind: "Previewed",
            sessionId: request.sessionId,
            queryId: request.queryId,
            sourceKey: request.sourceKey,
            key: request.key,
            returnAvailable: true,
          }
        : {
            kind: "Rejected",
            sessionId: request.sessionId,
            queryId: request.queryId,
            sourceKey: request.sourceKey,
            key: request.key,
            error: { kind: activation.reason },
          };
    },
    async clearPresentation(request) {
      assertCurrentSource(request.sourceKey, "clear");
      assertCurrentSession(request.sessionId, "clear");
      if (currentQueryId === 0) return;
      await capability.clear({
        sessionId: request.sessionId,
        queryId: currentQueryId,
        signal: request.signal,
      });
    },
    async returnToReadingPosition(request) {
      assertCurrentSource(request.sourceKey, "Return");
      assertCurrentSession(request.sessionId, "Return");
      const returned = await capability.returnToReadingPosition({
        sessionId: request.sessionId,
        signal: request.signal,
      });
      if (returned.kind === "Rejected") {
        throw new Error("Artifact Find reading origin is unavailable.");
      }
    },
    errorMessage(error) {
      switch (error.kind) {
        case "OriginUnavailable":
          return "The reading position could not be captured.";
      }
    },
  };
}
