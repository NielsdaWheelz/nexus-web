"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Presence } from "@/lib/api/presence";
import { hasExactKeys } from "@/lib/api/exact";
import type { EmphasisSegment } from "@/lib/ui/emphasis";
import {
  machineDocumentStyles,
  type MachineDocumentTheme,
} from "@/components/ui/MachineText";
import {
  DOSSIER_DOCUMENT_FIND_STYLES,
  DOSSIER_DOCUMENT_RUNTIME,
} from "@/components/dossier/dossierDocumentRuntime";
import { isRecord } from "@/lib/validation";
import styles from "./DossierDocumentFrame.module.css";

const QUERY_MAX_CODEPOINTS = 256;
const PROJECTION_MAX_CODEPOINTS = 160_000;
const SECTION_ID_MAX_CODEPOINTS = 256;
const SECTION_TITLE_MAX_CODEPOINTS = 512;
const MATCH_THRESHOLD = 2_000;
const SNIPPET_MAX_CODEPOINTS =
  QUERY_MAX_CODEPOINTS + 2 * 64;

export const DOSSIER_FIND_TRANSPORT_TIMEOUT_MS = 2_000;

export interface DossierDocumentFindSectionInfo {
  readonly id: string;
  readonly title: string;
}

export type DossierDocumentFindScope =
  | { readonly kind: "EntireResource" }
  | {
      readonly kind: "CurrentSection";
      readonly sectionId: string;
    };

export interface DossierDocumentFindOccurrence {
  readonly ordinal: number;
  readonly startCp: number;
  readonly endCp: number;
  readonly snippet: readonly EmphasisSegment[];
  readonly section: Presence<DossierDocumentFindSectionInfo>;
}

export type DossierDocumentFindResult =
  | {
      readonly kind: "Ready";
      readonly occurrences: readonly DossierDocumentFindOccurrence[];
    }
  | { readonly kind: "NoMatches" }
  | {
      readonly kind: "TooManyMatches";
      readonly threshold: 2_000;
    };

export type DossierDocumentFindActivation =
  | { readonly kind: "Activated"; readonly ordinal: number }
  | {
      readonly kind: "Rejected";
      readonly reason: "OriginUnavailable";
    };

export type DossierDocumentFindReturn =
  | { readonly kind: "Returned" }
  | {
      readonly kind: "Rejected";
      readonly reason: "OriginUnavailable";
    };

export interface DossierDocumentFindCapability {
  readonly revisionRef: string;
  readonly setFindEnabled: (enabled: boolean) => void;
  readonly prepare: (input: {
    readonly sessionId: number;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly projectionLengthCp: number;
    readonly currentSection: Presence<DossierDocumentFindSectionInfo>;
  }>;
  readonly find: (input: {
    readonly sessionId: number;
    readonly queryId: number;
    readonly query: string;
    readonly scope: DossierDocumentFindScope;
    readonly matchCase: boolean;
    readonly wholeWord: boolean;
    readonly signal: AbortSignal;
  }) => Promise<DossierDocumentFindResult>;
  readonly activate: (input: {
    readonly sessionId: number;
    readonly queryId: number;
    readonly ordinal: number;
    readonly signal: AbortSignal;
  }) => Promise<DossierDocumentFindActivation>;
  readonly clear: (input: {
    readonly sessionId: number;
    readonly queryId: number;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  readonly returnToReadingPosition: (input: {
    readonly sessionId: number;
    readonly signal: AbortSignal;
  }) => Promise<DossierDocumentFindReturn>;
}

const FRAME_CSP = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', "&quot;");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function currentTheme(): MachineDocumentTheme {
  if (typeof document === "undefined") return "dark";
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function useNexusDocumentTheme(): MachineDocumentTheme {
  const [theme, setTheme] = useState<MachineDocumentTheme>(currentTheme);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: light)") ?? null;
    const update = () => setTheme(currentTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    media?.addEventListener?.("change", update);
    update();
    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", update);
    };
  }, []);
  return theme;
}

export function buildDossierFrameDocument(input: {
  title: string;
  contentHtml: string;
  theme: MachineDocumentTheme;
  nonce: string;
  channel: string;
}): string {
  const csp = FRAME_CSP(input.nonce);
  const css = `${machineDocumentStyles(input.theme)}${DOSSIER_DOCUMENT_FIND_STYLES}`;
  return `<!doctype html><html lang="en" class="theme-${input.theme}" data-nexus-channel="${escapeHtmlAttribute(input.channel)}"><head><meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}"><title>${escapeHtmlText(input.title)}</title><style nonce="${input.nonce}">${css}</style><script nonce="${input.nonce}">${DOSSIER_DOCUMENT_RUNTIME}</script></head><body>${input.contentHtml}</body></html>`;
}

type IncomingMessage =
  | { readonly kind: "FindReady" }
  | {
      readonly kind: "FindPrepared";
      readonly sessionId: number;
      readonly projectionLengthCp: number;
      readonly currentSection: Presence<DossierDocumentFindSectionInfo>;
    }
  | {
      readonly kind: "FindResults";
      readonly sessionId: number;
      readonly queryId: number;
      readonly result: DossierDocumentFindResult;
    }
  | {
      readonly kind: "FindActivated";
      readonly sessionId: number;
      readonly queryId: number;
      readonly ordinal: number;
    }
  | {
      readonly kind: "FindActivationRejected";
      readonly sessionId: number;
      readonly queryId: number;
      readonly ordinal: number;
      readonly reason: "OriginUnavailable";
    }
  | {
      readonly kind: "FindCleared";
      readonly sessionId: number;
      readonly queryId: number;
    }
  | {
      readonly kind: "FindReturned";
      readonly sessionId: number;
    }
  | {
      readonly kind: "FindReturnRejected";
      readonly sessionId: number;
      readonly reason: "OriginUnavailable";
    }
  | { readonly kind: "FindRequested" }
  | {
      readonly kind: "Citation";
      readonly ordinal: number;
      readonly disposition: "Follow" | "Fork";
    };

function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return (
    length >= minimum &&
    length <= maximum &&
    !/[\r\n]/u.test(value)
  );
}

function decodeSectionInfo(
  value: unknown,
): DossierDocumentFindSectionInfo | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "title"]) ||
    !boundedString(value.id, 1, SECTION_ID_MAX_CODEPOINTS) ||
    !boundedString(value.title, 1, SECTION_TITLE_MAX_CODEPOINTS)
  ) {
    return null;
  }
  return { id: value.id, title: value.title };
}

function decodeSectionPresence(
  value: unknown,
): Presence<DossierDocumentFindSectionInfo> | null {
  if (!isRecord(value)) return null;
  if (hasExactKeys(value, ["kind"]) && value.kind === "Absent") {
    return { kind: "Absent" };
  }
  if (
    hasExactKeys(value, ["kind", "value"]) &&
    value.kind === "Present"
  ) {
    const section = decodeSectionInfo(value.value);
    return section ? { kind: "Present", value: section } : null;
  }
  return null;
}

function decodeSnippet(value: unknown): readonly EmphasisSegment[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    return null;
  }
  const segments: EmphasisSegment[] = [];
  let emphasizedCount = 0;
  let emphasizedIndex = -1;
  let totalCodepoints = 0;
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["text", "emphasized"]) ||
      typeof raw.text !== "string" ||
      raw.text.length === 0 ||
      typeof raw.emphasized !== "boolean"
    ) {
      return null;
    }
    totalCodepoints += Array.from(raw.text).length;
    if (raw.emphasized) {
      emphasizedCount += 1;
      emphasizedIndex = index;
    }
    segments.push({ text: raw.text, emphasized: raw.emphasized });
  }
  return (
    emphasizedCount === 1 &&
    (emphasizedIndex === 0 || emphasizedIndex === 1) &&
    value.length - emphasizedIndex <= 2 &&
    segments.every(({ text, emphasized }) =>
      Array.from(text).length <= (emphasized ? QUERY_MAX_CODEPOINTS : 64),
    ) &&
    totalCodepoints <= SNIPPET_MAX_CODEPOINTS
  )
    ? segments
    : null;
}

function decodeFindResult(value: unknown): DossierDocumentFindResult | null {
  if (!isRecord(value)) return null;
  if (hasExactKeys(value, ["kind"]) && value.kind === "NoMatches") {
    return { kind: "NoMatches" };
  }
  if (
    hasExactKeys(value, ["kind", "threshold"]) &&
    value.kind === "TooManyMatches" &&
    value.threshold === MATCH_THRESHOLD
  ) {
    return { kind: "TooManyMatches", threshold: MATCH_THRESHOLD };
  }
  if (
    !hasExactKeys(value, ["kind", "occurrences"]) ||
    value.kind !== "Ready" ||
    !Array.isArray(value.occurrences) ||
    value.occurrences.length < 1 ||
    value.occurrences.length > MATCH_THRESHOLD
  ) {
    return null;
  }
  const occurrences: DossierDocumentFindOccurrence[] = [];
  let priorEndCp = 0;
  for (let index = 0; index < value.occurrences.length; index += 1) {
    const raw = value.occurrences[index];
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "ordinal",
        "startCp",
        "endCp",
        "snippet",
        "section",
      ]) ||
      raw.ordinal !== index ||
      !isNonnegativeSafeInteger(raw.startCp) ||
      !isPositiveSafeInteger(raw.endCp) ||
      raw.startCp < priorEndCp ||
      raw.startCp >= raw.endCp ||
      raw.endCp > PROJECTION_MAX_CODEPOINTS
    ) {
      return null;
    }
    const snippet = decodeSnippet(raw.snippet);
    const section = decodeSectionPresence(raw.section);
    const emphasized = snippet?.find((segment) => segment.emphasized);
    if (
      !snippet ||
      !section ||
      !emphasized ||
      Array.from(emphasized.text).length !== raw.endCp - raw.startCp
    ) {
      return null;
    }
    occurrences.push({
      ordinal: index,
      startCp: raw.startCp,
      endCp: raw.endCp,
      snippet,
      section,
    });
    priorEndCp = raw.endCp;
  }
  return { kind: "Ready", occurrences };
}

function resultFitsProjection(
  result: DossierDocumentFindResult,
  projectionLengthCp: number,
): boolean {
  return (
    result.kind !== "Ready" ||
    result.occurrences.every(
      ({ startCp, endCp }) =>
        startCp < projectionLengthCp && endCp <= projectionLengthCp,
    )
  );
}

function decodeIncoming(
  value: unknown,
  channel: string,
): IncomingMessage | null {
  if (!isRecord(value) || value.channel !== channel) return null;
  if (
    hasExactKeys(value, ["channel", "kind"]) &&
    value.kind === "FindReady"
  ) {
    return { kind: "FindReady" };
  }
  if (
    hasExactKeys(value, ["channel", "kind"]) &&
    value.kind === "FindRequested"
  ) {
    return { kind: "FindRequested" };
  }
  if (
    hasExactKeys(value, ["channel", "disposition", "kind", "ordinal"]) &&
    value.kind === "Citation" &&
    isPositiveSafeInteger(value.ordinal) &&
    (value.disposition === "Follow" || value.disposition === "Fork")
  ) {
    return {
      kind: "Citation",
      ordinal: value.ordinal,
      disposition: value.disposition,
    };
  }
  if (
    hasExactKeys(value, [
      "channel",
      "kind",
      "sessionId",
      "projectionLengthCp",
      "currentSection",
    ]) &&
    value.kind === "FindPrepared" &&
    isPositiveSafeInteger(value.sessionId) &&
    isPositiveSafeInteger(value.projectionLengthCp) &&
    value.projectionLengthCp <= PROJECTION_MAX_CODEPOINTS
  ) {
    const currentSection = decodeSectionPresence(value.currentSection);
    return currentSection
      ? {
          kind: "FindPrepared",
          sessionId: value.sessionId,
          projectionLengthCp: value.projectionLengthCp,
          currentSection,
        }
      : null;
  }
  if (
    hasExactKeys(value, [
      "channel",
      "kind",
      "sessionId",
      "queryId",
      "result",
    ]) &&
    value.kind === "FindResults" &&
    isPositiveSafeInteger(value.sessionId) &&
    isPositiveSafeInteger(value.queryId)
  ) {
    const result = decodeFindResult(value.result);
    return result
      ? {
          kind: "FindResults",
          sessionId: value.sessionId,
          queryId: value.queryId,
          result,
        }
      : null;
  }
  if (
    hasExactKeys(value, [
      "channel",
      "kind",
      "sessionId",
      "queryId",
      "ordinal",
    ]) &&
    value.kind === "FindActivated" &&
    isPositiveSafeInteger(value.sessionId) &&
    isPositiveSafeInteger(value.queryId) &&
    isNonnegativeSafeInteger(value.ordinal)
  ) {
    return {
      kind: "FindActivated",
      sessionId: value.sessionId,
      queryId: value.queryId,
      ordinal: value.ordinal,
    };
  }
  if (
    hasExactKeys(value, [
      "channel",
      "kind",
      "sessionId",
      "queryId",
      "ordinal",
      "reason",
    ]) &&
    value.kind === "FindActivationRejected" &&
    value.reason === "OriginUnavailable" &&
    isPositiveSafeInteger(value.sessionId) &&
    isPositiveSafeInteger(value.queryId) &&
    isNonnegativeSafeInteger(value.ordinal)
  ) {
    return {
      kind: "FindActivationRejected",
      sessionId: value.sessionId,
      queryId: value.queryId,
      ordinal: value.ordinal,
      reason: "OriginUnavailable",
    };
  }
  if (
    hasExactKeys(value, ["channel", "kind", "sessionId", "queryId"]) &&
    value.kind === "FindCleared" &&
    isPositiveSafeInteger(value.sessionId) &&
    isPositiveSafeInteger(value.queryId)
  ) {
    return {
      kind: "FindCleared",
      sessionId: value.sessionId,
      queryId: value.queryId,
    };
  }
  if (
    hasExactKeys(value, ["channel", "kind", "sessionId"]) &&
    value.kind === "FindReturned" &&
    isPositiveSafeInteger(value.sessionId)
  ) {
    return { kind: "FindReturned", sessionId: value.sessionId };
  }
  if (
    hasExactKeys(value, ["channel", "kind", "sessionId", "reason"]) &&
    value.kind === "FindReturnRejected" &&
    value.reason === "OriginUnavailable" &&
    isPositiveSafeInteger(value.sessionId)
  ) {
    return {
      kind: "FindReturnRejected",
      sessionId: value.sessionId,
      reason: "OriginUnavailable",
    };
  }
  return null;
}

type ParentMessage =
  | { readonly channel: string; readonly kind: "FindHello" }
  | { readonly channel: string; readonly kind: "FindEnabled" }
  | { readonly channel: string; readonly kind: "FindDisabled" }
  | {
      readonly channel: string;
      readonly kind: "FindPrepare";
      readonly sessionId: number;
    }
  | {
      readonly channel: string;
      readonly kind: "FindQuery";
      readonly sessionId: number;
      readonly queryId: number;
      readonly query: string;
      readonly scope: DossierDocumentFindScope;
      readonly matchCase: boolean;
      readonly wholeWord: boolean;
    }
  | {
      readonly channel: string;
      readonly kind: "FindActivate";
      readonly sessionId: number;
      readonly queryId: number;
      readonly ordinal: number;
    }
  | {
      readonly channel: string;
      readonly kind: "FindClear";
      readonly sessionId: number;
      readonly queryId: number;
    }
  | {
      readonly channel: string;
      readonly kind: "FindReturn";
      readonly sessionId: number;
    };

type PendingCommand = {
  readonly accept: (message: IncomingMessage) => boolean;
  readonly reject: (reason: unknown) => void;
};

function transportError(message: string): Error {
  return new Error(message);
}

function abortError(): DOMException {
  return new DOMException("Dossier Find command aborted.", "AbortError");
}

function createGeneration(input: {
  readonly revisionRef: string;
  readonly nonce: string;
  readonly channel: string;
  readonly frame: () => HTMLIFrameElement | null;
}) {
  const pending = new Set<PendingCommand>();
  const projectionLengthBySession = new Map<number, number>();
  let disposed = false;
  let loadSeen = false;
  let readySeen = false;
  let published = false;
  let lifecycleEpoch = 0;

  const post = (message: ParentMessage): void => {
    if (disposed) {
      throw transportError("Dossier Find frame generation was replaced.");
    }
    const target = input.frame()?.contentWindow;
    if (!target) {
      throw transportError("Dossier Find frame is unavailable.");
    }
    target.postMessage(message, "*");
  };

  const request = <T,>(
    message: ParentMessage,
    signal: AbortSignal,
    match: (incoming: IncomingMessage) => T | undefined,
    settleAfterPost = false,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (timeout !== null) clearTimeout(timeout);
        if (!settleAfterPost) {
          signal.removeEventListener("abort", onAbort);
        }
        pending.delete(command);
      };
      const onAbort = () => {
        finish();
        reject(abortError());
      };
      const command: PendingCommand = {
        accept: (incoming) => {
          const value = match(incoming);
          if (value === undefined) return false;
          finish();
          resolve(value);
          return true;
        },
        reject: (reason) => {
          finish();
          reject(reason);
        },
      };
      pending.add(command);
      if (!settleAfterPost) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      timeout = setTimeout(() => {
        command.reject(
          transportError(
            `Dossier Find transport timed out after ${DOSSIER_FIND_TRANSPORT_TIMEOUT_MS}ms.`,
          ),
        );
      }, DOSSIER_FIND_TRANSPORT_TIMEOUT_MS);
      if (signal.aborted) {
        command.reject(abortError());
        return;
      }
      try {
        post(message);
      } catch (error) {
        command.reject(error);
      }
    });

  const capability: DossierDocumentFindCapability = {
    revisionRef: input.revisionRef,
    setFindEnabled: (enabled) => {
      if (disposed) return;
      post({
        channel: input.channel,
        kind: enabled ? "FindEnabled" : "FindDisabled",
      });
    },
    prepare: ({ sessionId, signal }) =>
      request(
        {
          channel: input.channel,
          kind: "FindPrepare",
          sessionId,
        },
        signal,
        (message) =>
          message.kind === "FindPrepared" &&
          message.sessionId === sessionId
            ? {
                projectionLengthCp: message.projectionLengthCp,
                currentSection: message.currentSection,
              }
            : undefined,
      ).then((prepared) => {
        projectionLengthBySession.set(
          sessionId,
          prepared.projectionLengthCp,
        );
        return prepared;
      }),
    find: ({
      sessionId,
      queryId,
      query,
      scope,
      matchCase,
      wholeWord,
      signal,
    }) =>
      request(
        {
          channel: input.channel,
          kind: "FindQuery",
          sessionId,
          queryId,
          query,
          scope,
          matchCase,
          wholeWord,
        },
        signal,
        (message) => {
          const projectionLengthCp =
            projectionLengthBySession.get(sessionId);
          return (
            message.kind === "FindResults" &&
            message.sessionId === sessionId &&
            message.queryId === queryId &&
            projectionLengthCp !== undefined &&
            resultFitsProjection(message.result, projectionLengthCp)
          )
            ? message.result
            : undefined;
        },
      ),
    activate: ({ sessionId, queryId, ordinal, signal }) =>
      request(
        {
          channel: input.channel,
          kind: "FindActivate",
          sessionId,
          queryId,
          ordinal,
        },
        signal,
        (message) => {
          if (
            message.kind === "FindActivated" &&
            message.sessionId === sessionId &&
            message.queryId === queryId &&
            message.ordinal === ordinal
          ) {
            return { kind: "Activated", ordinal };
          }
          if (
            message.kind === "FindActivationRejected" &&
            message.sessionId === sessionId &&
            message.queryId === queryId &&
            message.ordinal === ordinal
          ) {
            return {
              kind: "Rejected",
              reason: message.reason,
            };
          }
          return undefined;
        },
        true,
      ),
    clear: ({ sessionId, queryId, signal }) =>
      request(
        {
          channel: input.channel,
          kind: "FindClear",
          sessionId,
          queryId,
        },
        signal,
        (message) =>
          message.kind === "FindCleared" &&
          message.sessionId === sessionId &&
          message.queryId === queryId
            ? true
            : undefined,
      ).then(() => undefined),
    returnToReadingPosition: ({ sessionId, signal }) =>
      request(
        {
          channel: input.channel,
          kind: "FindReturn",
          sessionId,
        },
        signal,
        (message) => {
          if (
            message.kind === "FindReturned" &&
            message.sessionId === sessionId
          ) {
            input.frame()?.focus();
            return { kind: "Returned" };
          }
          if (
            message.kind === "FindReturnRejected" &&
            message.sessionId === sessionId
          ) {
            return {
              kind: "Rejected",
              reason: message.reason,
            };
          }
          return undefined;
        },
      ),
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const command of Array.from(pending)) {
      command.reject(
        transportError("Dossier Find frame generation was replaced."),
      );
    }
  };

  return {
    nonce: input.nonce,
    channel: input.channel,
    attach() {
      if (disposed) {
        throw transportError("Dossier Find frame generation was replaced.");
      }
      lifecycleEpoch += 1;
      return lifecycleEpoch;
    },
    detach(epoch: number) {
      queueMicrotask(() => {
        if (lifecycleEpoch === epoch) {
          dispose();
        }
      });
    },
    noteLoad() {
      loadSeen = true;
      post({
        channel: input.channel,
        kind: "FindHello",
      });
    },
    hello() {
      post({
        channel: input.channel,
        kind: "FindHello",
      });
    },
    receive(message: IncomingMessage): DossierDocumentFindCapability | null {
      if (message.kind === "FindReady") readySeen = true;
      for (const command of Array.from(pending)) {
        if (command.accept(message)) break;
      }
      if (!published && loadSeen && readySeen) {
        published = true;
        return capability;
      }
      return null;
    },
    wasPublished() {
      return published;
    },
    publishedCapability() {
      return published ? capability : null;
    },
  };
}

export default function DossierDocumentFrame({
  title,
  revisionRef,
  contentHtml,
  onCitation,
  onFindCapabilityChange,
  onFindRequested,
}: {
  title: string;
  revisionRef: string;
  contentHtml: string;
  onCitation: (
    ordinal: number,
    disposition: { readonly kind: "Follow" | "Fork" },
  ) => void;
  onFindCapabilityChange: (
    capability: DossierDocumentFindCapability | null,
  ) => void;
  onFindRequested: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const theme = useNexusDocumentTheme();
  const generationIdentity = useMemo(
    () => ({ revisionRef, contentHtml, title, theme }),
    [contentHtml, revisionRef, theme, title],
  );
  const generation = useMemo(
    () =>
      createGeneration({
        revisionRef: generationIdentity.revisionRef,
        nonce: randomToken(),
        channel: randomToken(),
        frame: () => frameRef.current,
      }),
    [generationIdentity],
  );
  const srcDoc = useMemo(
    () =>
      buildDossierFrameDocument({
        title,
        contentHtml,
        theme,
        nonce: generation.nonce,
        channel: generation.channel,
      }),
    [contentHtml, generation, theme, title],
  );
  const callbacksRef = useRef({
    onCitation,
    onFindCapabilityChange,
    onFindRequested,
  });
  callbacksRef.current = {
    onCitation,
    onFindCapabilityChange,
    onFindRequested,
  };

  useEffect(() => {
    const lifecycleEpoch = generation.attach();
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = decodeIncoming(event.data, generation.channel);
      if (!message) return;
      if (message.kind === "Citation") {
        callbacksRef.current.onCitation(message.ordinal, {
          kind: message.disposition,
        });
        return;
      }
      if (message.kind === "FindRequested") {
        callbacksRef.current.onFindRequested();
        return;
      }
      const capability = generation.receive(message);
      if (capability) {
        callbacksRef.current.onFindCapabilityChange(capability);
      }
    };
    window.addEventListener("message", receive);
    generation.hello();
    return () => {
      window.removeEventListener("message", receive);
      generation.detach(lifecycleEpoch);
    };
  }, [generation]);

  useEffect(() => {
    const capability = generation.publishedCapability();
    if (capability) {
      onFindCapabilityChange(capability);
    }
    return () => {
      if (generation.wasPublished()) {
        onFindCapabilityChange(null);
      }
    };
  }, [generation, onFindCapabilityChange]);

  return (
    <iframe
      key={generation.channel}
      ref={frameRef}
      className={styles.frame}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title={`Learning dossier: ${title}`}
      onLoad={() => generation.noteLoad()}
    />
  );
}
