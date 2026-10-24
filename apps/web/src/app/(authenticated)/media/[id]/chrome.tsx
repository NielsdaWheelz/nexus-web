"use client";

// The media pane's chrome around the reader: the header, document navigation,
// find, the inspector (Contents and Connections), the view menu, the document map rail, the pane width
// a pdf asks for, and the reader's keys (g chords, focus mode).
import { useEffect, useMemo, type ReactNode } from "react";
import { Activity } from "lucide-react";
import { useWorkspaceCondition } from "@/components/feedback/Feedback";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { groupContributorCredits, selectMediaAuthors } from "@/lib/contributors/credits";
import ReaderNavigation from "@/lib/documentReader/chrome/ReaderNavigation";
import { MapRail, type RailMarker } from "@/lib/documentReader/chrome/MapRail";
import type { ReaderDestination } from "@/lib/documentReader/location";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import type { FindController } from "@/lib/find/useFind";
import { mediaSummaryFromDetail, type MediaDetail } from "@/lib/media/mediaDetail";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import {
  PANE_COMMAND_RESOLVING_REASON,
  usePaneChrome,
  usePaneLayout,
} from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { paneSecondaryRegionId } from "@/lib/panes/paneSecondaryModel";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { openConversationAbout } from "@/lib/chat/conversationIndex";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { hasActiveInteractionOwner, isTopmostInteractionOwner } from "@/lib/ui/overlay";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import styles from "./media.module.css";

const FOCUS_CYCLE = { off: "distraction_free", distraction_free: "paragraph", paragraph: "sentence", sentence: "off" } as const;

export function useReaderChrome(input: {
  readonly media: MediaDetail | null;
  readonly failed: boolean;
  readonly reader: Reader;
  readonly find: FindController | null;
  readonly readable: boolean;
  readonly contents: ReactNode;
  readonly evidence: ReactNode;
  readonly annotationNotice: ReactNode;
  readonly markers: readonly RailMarker[];
  readonly onMarker: (id: string) => void;
  readonly markerTarget: (id: string) => ReaderDestination["target"];
  readonly isMobile: boolean;
  readonly paneActive: boolean;
  /** Esc with nothing else to close: drop the active deep-link target. */
}): void {
  const { media, reader, find, readable, isMobile, paneActive } = input;
  const { ctx } = useActionRuntime();
  const runtime = requirePaneRuntime(usePaneRuntime(), "useReaderChrome");
  const { activateTarget, requestSecondarySurface, toggleSecondaryPane, paneId } = runtime;
  const { profile, setTheme, setFocusMode } = useReaderContext();
  const documentFailed = useReaderState(reader, (s) => s.document.status === "failed");
  const kind = useReaderState(reader, (s) => (s.document.status === "ready" ? s.document.doc.kind : null));
  const sectioned = useReaderState(reader, (s) => s.document.status === "ready" && s.document.doc.kind === "text" && s.document.doc.sections.length > 0);
  const widthPx = useReaderState(reader, (s) => s.pdf?.widthPx ?? null);
  const id = media?.id ?? runtime.pathParams.id;
  const pdf = media?.kind === "pdf";

  useResourceInspector({
    scheme: "media",
    handle: media?.id ?? null,
    bodies: { contents: input.contents, linkedItems: input.evidence },
  });
  const navigation = useMemo(
    () => {
      if (!readable) return undefined;
      const hasNavigation = kind === "pdf" || kind === "text" && sectioned;
      if (!hasNavigation && !input.annotationNotice) return undefined;
      return {
        label: input.annotationNotice ? "reader controls" : kind === "pdf" ? "PDF controls" : "section navigation",
        content: <>{hasNavigation ? <ReaderNavigation reader={reader} /> : null}{input.annotationNotice}</>,
      };
    },
    [input.annotationNotice, kind, readable, reader, sectioned],
  );
  const menuActions = useMemo<ActionDescriptor[]>(() => {
    const resolving = media === null;
    const theme = (value: "light" | "dark", label: string): ActionDescriptor => ({
      kind: "command",
      id: `ViewAction.Reader.Theme.${label}`,
      label: profile.theme === value ? `${label} theme (current)` : `${label} theme`,
      disabled: resolving || profile.theme === value,
      disabledReason: resolving ? PANE_COMMAND_RESOLVING_REASON : undefined,
      onSelect: () => setTheme(value),
    });
    return [
      {
        kind: "link",
        id: "consumption-activity",
        label: "Activity",
        icon: <Activity size={16} aria-hidden="true" />,
        href: "/stats",
      },
      {
        kind: "command",
        id: "ViewAction.Reader.Settings",
        label: "Reader settings",
        restoreFocusOnClose: false,
        onSelect: ({ openIntent }) =>
          activateTarget({ target: { href: "/settings/reader", labelHint: "Reader settings" }, disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" } }),
      },
      ...(pdf
        ? [
            {
              kind: "custom" as const,
              id: "ViewAction.Reader.PdfSourceColors",
              label: "PDF pages keep their source colors",
              render: () => <div className={styles.menuStatus}>PDF pages keep their source colors</div>,
            },
          ]
        : [theme("light", "Light"), theme("dark", "Dark")]),
    ];
  }, [activateTarget, media, pdf, profile.theme, setTheme]);
  const seed = useMemo(() => media === null ? null : mediaSummaryFromDetail(media), [media]);
  const summaries = useMediaSummaries(seed === null ? [] : [seed]);
  const summary = seed === null ? null : summaries.resolve(seed);
  useWorkspaceCondition(`media-summary:${paneId}:${id}`, summaries.error === null ? null : {
    priority: "Status",
    announcement: "Polite",
    content: {
      tone: "Warning",
      title: "couldn’t update items",
      requestId: summaries.error.requestId,
    },
    actions: [{ label: "try again", busy: summaries.retrying, onClick: summaries.retry }],
    returnFocus: () => findPaneLandmarkFocusTarget(paneId),
  });
  const authors = summary
    ? groupContributorCredits(selectMediaAuthors(summary.contributors)).find((group) => group.role === "author")
    : undefined;
  usePaneChrome(
    useMemo(
      () => ({
        header: seed !== null && summary === null
          ? { kind: "Resource" as const, resource: { status: "Unavailable" as const } }
          : media
          ? {
              kind: "Resource" as const,
              resource: {
                status: "Ready" as const,
                creditGroups: authors ? [{ kind: "Authors" as const, credits: authors.credits }] : [],
              },
            }
          : input.failed
            ? { kind: "Resource" as const, resource: { status: "Failed" as const } }
            : undefined,
        resourceActions: summary === null ? undefined : {
          kind: "Media" as const,
          subject: { kind: "Stored" as const, summary },
          knownDescriptor: media?.playerDescriptor ?? null,
        },
        navigation,
        query: find
          ? { kind: "Find" as const, find }
          : !input.failed && !documentFailed && (media === null || readable)
            ? { kind: "Find" as const, find: null }
            : undefined,
        resourceRef: canonicalResourceRef({ scheme: "media", id }),
        menuActions,
      }),
      [authors, seed, summary, documentFailed, find, id, input.failed, navigation, media, menuActions, readable],
    ),
  );
  // a pdf's own width is the pane's minimum; the map rail sits beside the body.
  usePaneLayout(
    useMemo(
      () => ({
        intrinsicWidthPx: pdf ? widthPx : null,
        rail:
          readable && !isMobile
            ? {
                widthPx: 52,
                body: (
                  <section aria-label="Document Map overview" className={styles.rail}>
                    <MapRail reader={reader} evidence={{ markers: input.markers, onMarker: input.onMarker, markerTarget: input.markerTarget }} />
                  </section>
                ),
              }
            : null,
      }),
      [input.markers, input.onMarker, input.markerTarget, isMobile, pdf, readable, reader, widthPx],
    ),
  );

  // Keys: g (inspector), g e (evidence), g c or shift+G (chat), cmd/ctrl+shift+F
  // (cycle focus mode), shift+Esc (focus off).
  useEffect(() => {
    if (!paneActive) return;
    const region = paneSecondaryRegionId(paneId);
    let pending: number | null = null;
    const chat = () => void openConversationAbout({
      ctx, originPaneId: paneId, intent: "default", ref: canonicalResourceRef({ scheme: "media", id }), subject: media?.title,
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      const owned = !hasActiveInteractionOwner() || isTopmostInteractionOwner(region);
      if (event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && owned) {
        event.preventDefault();
        return setFocusMode(FOCUS_CYCLE[profile.focus_mode]);
      }
      // Escape belongs to an open layer (the inspector sheet included): one press, one action.
      if (event.key === "Escape") {
        if (hasActiveInteractionOwner()) return;
        if (event.shiftKey && profile.focus_mode !== "off") {
          event.preventDefault();
          setFocusMode("off");
        }
        return;
      }
      if (!owned || event.metaKey || event.ctrlKey || event.altKey) return;
      if (pending !== null) {
        window.clearTimeout(pending);
        pending = null;
        if (event.key === "e") requestSecondarySurface("resource-connections");
        else if (event.key === "c") chat();
        else return toggleSecondaryPane();
        event.preventDefault();
      } else if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (event.shiftKey) return chat();
        pending = window.setTimeout(() => {
          pending = null;
          toggleSecondaryPane();
        }, 500);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      document.removeEventListener("keydown", keydown);
    };
  }, [ctx, id, media?.title, paneActive, paneId, profile.focus_mode, requestSecondarySurface, setFocusMode, toggleSecondaryPane]);
}
