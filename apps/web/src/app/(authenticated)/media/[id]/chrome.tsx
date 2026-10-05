"use client";

// The media pane's chrome around the reader: the header, the pane-bar
// instrument (sections, or pdf pages and zoom), find, the inspector (Contents,
// Evidence, the dossier), the view menu, the document map rail, the pane width
// a pdf asks for, and the reader's keys (g chords, focus mode).
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Activity, ChevronLeft, ChevronRight } from "lucide-react";
import { FindResults } from "@/components/find/FindBar";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import PaneToolbar from "@/components/ui/PaneToolbar";
import Select from "@/components/ui/Select";
import { usePaneFixedChrome } from "@/components/workspace/PaneFixedChrome";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { groupContributorCredits, selectMediaAuthors } from "@/lib/contributors/formatting";
import { MapRail, type RailMarker } from "@/lib/documentReader/chrome/MapRail";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import { PDF_ZOOM } from "@/lib/documentReader/model";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import type { FindController } from "@/lib/find/useFind";
import type { MediaDetail } from "@/lib/media/mediaDetail";
import { PANE_COMMAND_RESOLVING_REASON } from "@/lib/panes/panePublications";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { paneSecondaryRegionId } from "@/lib/panes/paneSecondaryModel";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { executeResourceChat } from "@/lib/resources/resourceActionExecution";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { hasActiveInteractionOwner, isTopmostInteractionOwner } from "@/lib/ui/useEscapeKey";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import styles from "./media.module.css";

const FOCUS_CYCLE = { off: "distraction_free", distraction_free: "paragraph", paragraph: "sentence", sentence: "off" } as const;

/** Previous/next and the picker over the publisher's sections; `i / n` at the reading point. */
function SectionInstrument({ reader }: { readonly reader: Reader }) {
  const ready = useReaderState(reader, (s) => (s.document.status === "ready" && s.document.doc.kind === "text" ? s.document : null));
  const current = useReaderState(reader, (s) =>
    s.document.status === "ready" && s.viewport ? (s.document.structure.sectionAt(s.viewport.primary)?.id ?? null) : null,
  );
  const sections = useMemo(
    () =>
      ready?.doc.kind === "text"
        ? [...ready.doc.sections].sort(
            (a, b) =>
              ready.structure.fraction({ kind: "text", ...a.at }) - ready.structure.fraction({ kind: "text", ...b.at }),
          )
        : [],
    [ready],
  );
  const index = sections.findIndex((section) => section.id === current);
  const go = (to: number) => {
    const section = sections[to];
    if (section) void reader.inspect({ kind: "point", point: { kind: "text", ...section.at } });
  };
  return (
    <PaneToolbar
      variant="Instrument"
      controls={
        <>
          <Button variant="ghost" size="sm" iconOnly aria-label="Previous section" disabled={index <= 0} onClick={() => go(index - 1)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          {index >= 0 ? (
            <span className={styles.instrumentStatus} aria-label={`Section ${index + 1} of ${sections.length}`}>
              {index + 1} / {sections.length}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Next section"
            disabled={index >= sections.length - 1}
            onClick={() => go(index + 1)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
          <Select
            size="sm"
            className={styles.sectionSelect}
            aria-label="Select section"
            value={current ?? ""}
            title={sections[index]?.label}
            onChange={(event) => go(sections.findIndex((section) => section.id === event.target.value))}
          >
            <option value="" disabled>
              between sections
            </option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.label}
              </option>
            ))}
          </Select>
        </>
      }
    />
  );
}

/** Pages are reader jumps (a held spot); zoom steps by a quarter within the ui range. */
function PdfInstrument({ reader }: { readonly reader: Reader }) {
  const pdf = useReaderState(reader, (s) => s.pdf);
  if (!pdf) return null;
  const page = (to: number) => void reader.inspect({ kind: "point", point: { kind: "pdf", page: to, y: 0 } });
  return (
    <PaneToolbar
      variant="Instrument"
      controls={
        <>
          <Button variant="ghost" size="sm" iconOnly aria-label="Previous page" disabled={pdf.page <= 1} onClick={() => page(pdf.page - 1)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          <span className={styles.instrumentStatus} aria-label={`Page ${pdf.page} of ${pdf.pages}`}>
            {pdf.page} / {pdf.pages}
          </span>
          <Button variant="ghost" size="sm" iconOnly aria-label="Next page" disabled={pdf.page >= pdf.pages} onClick={() => page(pdf.page + 1)}>
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
          <ActionMenu
            label="More actions"
            options={[
              { kind: "command", id: "zoom-out", label: "Zoom out", disabled: pdf.scale <= PDF_ZOOM.min, onSelect: () => reader.setZoom(pdf.scale - PDF_ZOOM.step) },
              { kind: "command", id: "zoom-in", label: "Zoom in", disabled: pdf.scale >= PDF_ZOOM.max, onSelect: () => reader.setZoom(pdf.scale + PDF_ZOOM.step) },
            ]}
          />
        </>
      }
    />
  );
}

export function useReaderChrome(input: {
  readonly media: MediaDetail | null;
  readonly failed: boolean;
  readonly reader: Reader;
  readonly find: FindController | null;
  readonly readable: boolean;
  readonly contents: ReactNode;
  readonly evidence: ReactNode;
  readonly markers: readonly RailMarker[];
  readonly onMarker: (id: string) => void;
  readonly isMobile: boolean;
  readonly paneActive: boolean;
  /** Esc with nothing else to close: drop the active deep-link target. */
  readonly onDismissTarget: () => void;
}): void {
  const { media, reader, find, readable, isMobile, paneActive } = input;
  const runtime = requirePaneRuntime(usePaneRuntime(), "useReaderChrome");
  const { activateTarget, requestSecondarySurface, paneId } = runtime;
  const { profile, setTheme, setFocusMode } = useReaderContext();
  const kind = useReaderState(reader, (s) => (s.document.status === "ready" ? s.document.doc.kind : null));
  const sectioned = useReaderState(reader, (s) => s.document.status === "ready" && s.document.doc.kind === "text" && s.document.doc.sections.length > 0);
  const widthPx = useReaderState(reader, (s) => s.pdf?.widthPx ?? null);
  const id = media?.id ?? runtime.pathParams.id;
  const pdf = media?.kind === "pdf";

  const inspector = useResourceInspector({
    scheme: "media",
    handle: id,
    bodies: { contents: input.contents, linkedItems: input.evidence },
    searchResults: useMemo(() => (find ? <FindResults find={find} /> : undefined), [find]),
  });
  const commands = useRef(inspector);
  commands.current = inspector;

  const instrument = useMemo(
    () =>
      !readable
        ? undefined
        : kind === "pdf"
          ? { label: "PDF controls", content: <PdfInstrument reader={reader} /> }
          : kind === "text" && sectioned
            ? { label: "section navigation", content: <SectionInstrument reader={reader} /> }
            : undefined,
    [kind, readable, reader, sectioned],
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
        onSelect: () =>
          activateTarget({ target: { href: "/settings/reader", labelHint: "Reader settings" }, disposition: { kind: "Fork" } }),
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
  const authors = media
    ? groupContributorCredits(selectMediaAuthors(media.contributors)).find((group) => group.role === "author")
    : undefined;
  usePanePrimaryChrome(
    useMemo(
      () => ({
        header: media
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
        ...(instrument ? { instrument } : {}),
        search: find
          ? { kind: "Find" as const, find }
          : media === null || (readable && media.kind !== "podcast_episode" && media.kind !== "video")
            ? { kind: "Resolving" as const, control: "Find" as const }
            : undefined,
        companionAction: inspector.companionAction ?? undefined,
        actionSubject: { ref: canonicalResourceRef({ scheme: "media", id }) },
        menuActions,
      }),
      [authors, find, id, input.failed, inspector.companionAction, instrument, media, menuActions, readable],
    ),
  );
  usePaneFixedChrome(
    useMemo(
      () =>
        readable && !isMobile
          ? {
              id: "reader-document-map-overview-rail" as const,
              widthPx: 52,
              body: (
                <section aria-label="Document Map overview" className={styles.rail}>
                  <MapRail reader={reader} markers={input.markers} onMarker={input.onMarker} />
                </section>
              ),
            }
          : null,
      [input.markers, input.onMarker, isMobile, readable, reader],
    ),
  );

  const { setPaneLayout } = runtime;
  useEffect(() => {
    setPaneLayout(
      pdf
        ? widthPx
          ? { primaryWidth: { kind: "intrinsic", widthPx } }
          : null
        : { primaryWidth: { kind: "workspace" } },
    );
    return () => setPaneLayout(null);
  }, [pdf, setPaneLayout, widthPx]);

  // Keys: g (inspector), g e (evidence), g c or shift+G (chat), cmd/ctrl+shift+F
  // (cycle focus mode), shift+Esc (focus off), Esc (drop the active target).
  const dismiss = useRef(input.onDismissTarget);
  dismiss.current = input.onDismissTarget;
  useEffect(() => {
    if (!paneActive) return;
    const region = paneSecondaryRegionId(paneId, "resource-inspector");
    let pending: number | null = null;
    const openInspector = () => commands.current.companionAction?.onSelect({ triggerEl: null });
    const chat = () =>
      void executeResourceChat({
        ref: canonicalResourceRef({ scheme: "media", id }),
        openConversation: (conversationId) => {
          activateTarget({ target: { href: `/conversations/${conversationId}`, labelHint: "Chat" }, disposition: { kind: "Adopt" } });
        },
      });
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      const owned = !hasActiveInteractionOwner() || isTopmostInteractionOwner(region);
      if (event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && owned) {
        event.preventDefault();
        return setFocusMode(FOCUS_CYCLE[profile.focus_mode]);
      }
      if (event.key === "Escape" && owned) {
        if (event.shiftKey && profile.focus_mode !== "off") {
          event.preventDefault();
          setFocusMode("off");
        } else if (!event.shiftKey) dismiss.current();
        return;
      }
      if (!owned || event.metaKey || event.ctrlKey || event.altKey) return;
      if (pending !== null) {
        window.clearTimeout(pending);
        pending = null;
        if (event.key === "e") requestSecondarySurface("resource-evidence");
        else if (event.key === "c") chat();
        else return openInspector();
        event.preventDefault();
      } else if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (event.shiftKey) return chat();
        pending = window.setTimeout(() => {
          pending = null;
          openInspector();
        }, 500);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      document.removeEventListener("keydown", keydown);
    };
  }, [activateTarget, id, paneActive, paneId, profile.focus_mode, requestSecondarySurface, setFocusMode]);
}
