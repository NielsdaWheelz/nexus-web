"use client";

/**
 * The import page (docs/modules/app-navigation.md#the-import-page), one tree for both shells.
 * A field over one grid: what enter would send, the intake's lines with each settled batch's
 * colophon, `choose a file…`, the recent shelf while there are no lines, and `all imports`.
 * Focus stays in the field and the grid's selection is its active descendant. The intake
 * owns every line and its words; the page admits, selects and runs a row's verb.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ArrowLeft, Import } from "lucide-react";
import { Failed, Field } from "@/components/feedback/Fact";
import { sentence, ShellContext, type Line } from "@/components/feedback/stage";
import DestinationChooser, { DestinationTrigger, setDestination } from "@/components/libraries/DestinationChooser";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import Button from "@/components/ui/Button";
import collection from "@/components/ui/Collection.module.css";
import Input from "@/components/ui/Input";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import PickerSurface from "@/components/ui/PickerSurface";
import type { ApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { extractLinks } from "@/lib/extractLinks";
import { fetchImportPage, type ImportItem } from "@/lib/imports/api";
import { attentionPhrase, FAILURE_COPY, reasonLine } from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import { ADMIT_LIMIT, useImportCreation, useImportIntake, useImportLinesShown, type IntakeLine } from "@/lib/imports/intake";
import { batchSlip, colophon, linePhase, linkPointer, lineView, pointer, type LineVerb } from "@/lib/imports/lineView";
import { encodeImportsUrl } from "@/lib/imports/query";
import { mediaKindLabel } from "@/lib/media/kind";
import { metadataOperationName } from "@/lib/media/mediaMetadataCopy";
import type { NexusPage } from "@/lib/nexus/model";
import { flattenedPaste } from "@/lib/nexus/query";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteModel";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { readerSurfaceStyle } from "@/lib/reader/typography";
import { useRenderEnvironment, useTouchCapable } from "@/lib/renderEnvironment/provider";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { revealCollectionItem } from "@/lib/ui/collection";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import type { WorkspaceTarget } from "@/lib/workspace/targetActivation";
import ImportLine, { lineName, type ButtonVerb } from "./ImportLine";
import type { NexusController } from "./useNexusController";
import nexus from "./Nexus.module.css";
import styles from "./ImportPage.module.css";

const GRID_ID = "import-options";
const HELP_ID = "import-help";
const FIELD_ID = "import-field-line";
const CREATE_ID = "import-create-line";
const cellId = (key: string) => `import-row-${encodeURIComponent(key)}`;
const lineKey = (line: IntakeLine) => `Line:${line.id}`;
const AllImports = getPaneRouteIcon("/imports");

type Disposition = "Follow" | "Fork";
type Selectable =
  | { readonly kind: "Commit"; readonly key: string; readonly links: readonly string[] }
  /** `fall` is its place in a batch admitted while the page shows; null if it was here already. */
  | { readonly kind: "Line"; readonly key: string; readonly line: IntakeLine; readonly fall: number | null }
  | { readonly kind: "Choose"; readonly key: string }
  | { readonly kind: "Shelf"; readonly key: string; readonly item: ImportItem }
  | { readonly kind: "All"; readonly key: string };
type Row = Selectable
  | { readonly kind: "Colophon"; readonly key: string; readonly text: string }
  | { readonly kind: "Heading"; readonly key: string; readonly text: string }
  | { readonly kind: "ShelfFailed"; readonly key: string; readonly error: ApiError };

export default function ImportPage({ controller, page, mobile }: {
  readonly controller: NexusController;
  readonly page: Extract<NexusPage, { kind: "Import" }>;
  readonly mobile: boolean;
}) {
  const intake = useImportIntake();
  useImportLinesShown();
  const creation = useImportCreation();
  const { profile } = useReaderContext();
  const { displayTimeZone } = useRenderEnvironment();
  const coarse = useTouchCapable();
  const { summary, observation, revision, retainObserver } = useImports();
  const { signIn } = useContext(ShellContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const againRef = useRef<HTMLInputElement>(null);
  const intoRef = useRef<HTMLButtonElement>(null);
  /** The expired line whose file is being chosen again. */
  const again = useRef<string | null>(null);
  const composing = useRef(false);
  const [choosing, setChoosing] = useState(false);
  const [fieldLine, setFieldLine] = useState<Line | null>(null);
  const [focused, setFocused] = useState(false);
  // `moved`: an arrow handed enter to the row since the field's last edit, even if it clamped
  const [selection, setSelection] = useState(() => {
    const url = page.select === null ? null : new URL(page.select).href;
    const line = intake.lines.find(line => line.source.kind === "Link" && line.source.url === url);
    return { key: line === undefined ? null : lineKey(line), moved: false };
  });
  const [present] = useState(() => new Set(intake.lines.map(line => line.id)));

  // justify-polling: the shelf has no timer of its own. it rereads Recent on each Imports
  // observation while it shows, retaining the observer so that clock keeps its 5 s beat.
  const shelfShown = intake.lines.length === 0;
  useEffect(() => shelfShown ? retainObserver() : undefined, [shelfShown, retainObserver]);
  const shelf = usePaneFreeServerValue({ key: shelfShown ? "import-shelf" : null, stale: `${revision}:${observation}`,
    load: signal => fetchImportPage("view=Recent", null, 5, signal) });

  const { links } = extractLinks(intake.field, "UrlsOrSoleDomain");
  const rows: Row[] = links.length > 0 ? [{ kind: "Commit", key: "Commit", links }] : [];
  // lines newest batch first, a batch in admission order and closed by its colophon once settled
  const batches: IntakeLine[][] = [];
  for (const line of intake.lines) {
    const last = batches.at(-1);
    if (last !== undefined && last[0]!.batch === line.batch) last.push(line);
    else batches.push([line]);
  }
  for (const batch of batches) {
    batch.forEach((line, at) => rows.push({ kind: "Line", key: lineKey(line), line, fall: present.has(line.id) ? null : Math.min(at, 7) }));
    const text = colophon(batch, new Date(), displayTimeZone);
    if (text !== null) rows.push({ kind: "Colophon", key: `Colophon:${batch[0]!.batch}`, text });
  }
  rows.push({ kind: "Choose", key: "Choose" });
  if (shelfShown && shelf.status === "failed") rows.push({ kind: "ShelfFailed", key: "ShelfFailed", error: shelf.error });
  if (shelfShown && shelf.status === "ready" && shelf.data.items.length > 0) {
    rows.push({ kind: "Heading", key: "Recent", text: "recent" });
    for (const item of shelf.data.items) rows.push({ kind: "Shelf", key: `Shelf:${item.ref}`, item });
  }
  rows.push({ kind: "All", key: "All" });

  const selectable = rows.filter((row): row is Selectable => row.kind !== "Colophon" && row.kind !== "Heading" && row.kind !== "ShelfFailed");
  const keys = selectable.map(row => row.key);
  // enter's target: the field while it holds text and the selection is unmoved since
  const fieldTargeted = intake.field.trim() !== "" && !selection.moved;
  const active = fieldTargeted && links.length > 0 ? "Commit"
    : selection.key !== null && keys.includes(selection.key) ? selection.key : keys[0] ?? null;

  useLayoutEffect(() => {
    const cell = active === null ? null : document.getElementById(cellId(active));
    if (scrollRef.current && cell) revealCollectionItem(scrollRef.current, cell);
  }, [active]);

  // a batch that settles here says so once: its colophon, or a lone line's outcome
  const settled = useRef<ReadonlySet<string> | null>(null);
  const { announce } = controller;
  useEffect(() => {
    const now = new Set(batches.filter(batch => batch.every(line => linePhase(line.stage) === "Settled")).map(batch => batch[0]!.batch));
    const before = settled.current;
    settled.current = now;
    if (before === null) return;
    for (const batch of batches) {
      if (!now.has(batch[0]!.batch) || before.has(batch[0]!.batch)) continue;
      const slip = batch.length === 1 ? batchSlip(batch) : null;
      const said = batch.length > 1 ? colophon(batch, new Date(), displayTimeZone) : slip === null ? null : sentence(slip.line);
      if (said !== null) announce(said);
    }
  });

  /** Failure, a moved selection, input and exit disarm: an armed line opens only from here. */
  function disarm(except: string | null) {
    for (const line of intake.lines) if (line.openOnAccept !== null && lineKey(line) !== except) intake.disarm(line.id);
  }
  function select(key: string) {
    disarm(key);
    setSelection({ key, moved: true });
  }
  function edit(text: string) {
    intake.setField(text);
    setFieldLine(null);
    setSelection(current => ({ ...current, moved: false }));
    disarm(null);
  }

  /** Sends links. One already listed adds no line, and the selection goes to it. */
  function sendLinks(sending: readonly string[], disposition: Disposition) {
    const urls = sending.map(link => new URL(link).href);
    const listed = intake.lines.find(line => line.source.kind === "Link" && urls.includes(line.source.url)) ?? null;
    controller.admitImport({ links: sending, files: [], ...(disposition === "Fork" ? { open: "Fork" } as const : {}) });
    if (listed !== null) announce(`“${pointer(listed)}” is already listed.`);
    setSelection({ key: listed === null ? null : lineKey(listed), moved: false });
  }
  /** The sieve: enter takes the links and leaves the rest, which says it is not a link. */
  function sendField(disposition: Disposition) {
    const { links: found, rest } = extractLinks(intake.field, "UrlsOrSoleDomain");
    if (found.length === 0) return setFieldLine({ fact: "not a link" });
    if (found.length > ADMIT_LIMIT) return setFieldLine({ fact: `100 at a time. this has ${found.length}.` });
    sendLinks(found, disposition);
    intake.setField(rest);
    setFieldLine(rest === "" ? null : { fact: "not a link" });
  }
  function admitFiles(files: readonly File[]) {
    if (files.length > ADMIT_LIMIT) return setFieldLine({ fact: `100 at a time. this has ${files.length}.` });
    if (files.length === 0) return;
    controller.admitImport({ links: [], files });
    setSelection({ key: null, moved: false });
  }

  const open = (target: WorkspaceTarget, disposition: Disposition) =>
    controller.openTarget({ kind: "InternalHref", ...target }, { disposition: { kind: disposition } });
  function press(line: IntakeLine, verb: ButtonVerb) {
    switch (verb.kind) {
      case "Retry": return intake.retry(line.id);
      case "RetryWithout": return intake.retryWithout(line.id);
      case "ChooseAgain":
        again.current = line.id;
        return againRef.current?.click();
      case "SignIn":
        if (signIn === null) return;
        if ("href" in signIn) return window.location.assign(signIn.href);
        return signIn.run("default");
      case "Reload": return window.location.reload();
      case "SeeWhy": case "AllImports": return open(verb.target, "Follow");
    }
  }
  function runLine(line: IntakeLine, verb: LineVerb | null, disposition: Disposition) {
    if (verb === null) return;
    switch (verb.kind) {
      case "Arm": return intake.arm(line.id, disposition);
      case "Open": case "SeeWhy": case "AllImports": return open(verb.target, disposition);
      case "OpenOriginal": return void window.open(verb.href, "_blank", "noopener,noreferrer");
      default: return press(line, verb);
    }
  }
  function run(row: Selectable, disposition: Disposition) {
    switch (row.kind) {
      case "Commit": return sendField(disposition);
      case "Line": return runLine(row.line, viewOf(row.line).verb, disposition);
      // a picker opens only inside its gesture
      case "Choose": return filesRef.current?.click();
      case "Shelf": return open(shelfTarget(row.item), disposition);
      case "All": return open({ href: "/imports", labelHint: "imports" }, disposition);
    }
  }
  function click(row: Selectable, event: MouseEvent<HTMLElement>) {
    // a line's own controls run themselves
    if (event.target instanceof Element && event.target.closest("button, a")) return;
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    select(row.key);
    run(row, activation.intent === "new_pane" ? "Fork" : "Follow");
  }
  /** A sign-in no shell offers is no verb. */
  function viewOf(line: IntakeLine) {
    const view = lineView(line);
    return view.verb?.kind === "SignIn" && signIn === null ? { ...view, verb: null } : view;
  }

  const placeholder = coarse ? intake.lines.length > 0 ? "another link" : "paste a link"
    : intake.lines.length > 0 ? "another link, or a file" : "paste a link, or drop a file";
  const attention = summary.status === "ready" ? summary.data.needs_attention_count : 0;
  const back = <Button iconOnly icon={<ArrowLeft />} className={mobile ? nexus.iconButton : undefined}
    aria-label="back" tooltip={{ text: "back to palette" }} onClick={controller.back} />;

  return (
    <section className={styles.page} data-mobile={mobile || undefined} style={readerSurfaceStyle(profile)}>
      {mobile
        ? <header className={nexus.header}>{back}<h2 tabIndex={-1} data-switchboard-heading>import</h2></header>
        : <h2 className="sr-only" tabIndex={-1} data-switchboard-heading>import</h2>}
      <div className={styles.fieldRow} data-feedback-controls="true">
        <div className={styles.fieldBox}>
          {mobile ? null : back}
          <Input
            ref={inputRef}
            bare
            role="combobox"
            aria-label="links to import"
            aria-haspopup="grid"
            aria-controls={GRID_ID}
            aria-expanded="true"
            aria-activedescendant={focused && active !== null ? cellId(active) : undefined}
            aria-describedby={[HELP_ID, fieldLine ? FIELD_ID : null, creation.error ? CREATE_ID : null].filter(Boolean).join(" ")}
            className={styles.field}
            value={intake.field}
            placeholder={placeholder}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={event => edit(event.currentTarget.value)}
            onPaste={event => {
              const value = flattenedPaste(event);
              if (value !== null) edit(value);
            }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
                // the modal's escape owner must not see an IME key
                event.stopPropagation();
                return;
              }
              const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
              if (event.key === "Escape" && fieldLine !== null) {
                event.preventDefault();
                setFieldLine(null);
              } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && plain) {
                const next = nextRovingIndexForKey({ key: event.key, currentIndex: active === null ? -1 : keys.indexOf(active),
                  itemCount: keys.length, orientation: "vertical", homeEnd: false });
                if (next === null) return;
                event.preventDefault();
                select(keys[next]!);
              } else if (event.key === "Enter") {
                const activation = workspaceTargetActivationIntent(event, "activate");
                if (activation.kind === "Unowned") return;
                event.preventDefault();
                if (activation.kind === "Consume") return;
                const disposition = activation.intent === "new_pane" ? "Fork" : "Follow";
                if (fieldTargeted) return sendField(disposition);
                const row = selectable.find(row => row.key === active);
                if (row !== undefined) run(row, disposition);
              }
            }}
          />
        </div>
        <div className={styles.into}>
          <DestinationTrigger ref={intoRef} label="into" accessibleLabel="import into" emptyLabel="All" chosen={intake.into}
            expanded={choosing} disabled={false} controls={{ kind: "dialog" }} onToggle={() => setChoosing(current => !current)} />
        </div>
      </div>
      <span id={HELP_ID} className="sr-only">with links here, enter imports them.</span>
      {fieldLine || creation.error ? <div className={styles.fieldLines}>
        {fieldLine ? <Field id={FIELD_ID} line={fieldLine} /> : null}
        {creation.error ? <Field id={CREATE_ID} line={{ fact: creation.error.content.title, reason: creation.error.content.message }}
          verbs={creation.error.retry ? [{ label: "retry", commandKey: creation.error.commandKey ?? "import-into-create", busy: creation.error.busy, run: creation.error.retry }] : undefined} /> : null}
      </div> : null}
      <PickerSurface active={choosing} onClose={() => setChoosing(false)} anchor={() => intoRef.current} title="libraries" align="end">
        <DestinationChooser context="import-into" selection={{ kind: "Item", chosen: intake.into }} disabled={false}
          onSet={change => { intake.setInto(setDestination(intake.into, change)); return true; }}
          create={{ available: true, pendingNames: creation.pendingNames, onCreate: name => creation.admit({ name, scope: "import-into" }) }}
          error={creation.error} />
      </PickerSurface>
      <div ref={scrollRef} className={`${collection.fillViewport} ${styles.scroll}`} data-collection-viewport="">
        <div id={GRID_ID} role="grid" aria-label="import options" aria-colcount={1} className={styles.grid}>
          {rows.map(row => {
            switch (row.kind) {
              case "Colophon": return <div key={row.key} role="row" className={styles.colophon}><div role="gridcell">{row.text}</div></div>;
              case "Heading": return <div key={row.key} role="row" className={styles.heading}><div role="gridcell"><h3>{row.text}</h3></div></div>;
              case "ShelfFailed": return <div key={row.key} role="row" className={styles.failed}><div role="gridcell">
                <Failed error={row.error} noun="recent imports" retry={{ run: () => void shelf.refetch() }} />
              </div></div>;
            }
            const selected = row.key === active;
            const tabIndex = selected || mobile ? 0 : -1;
            const cell = (name: string, content: ReactNode) => <div role="row" key={row.key} aria-selected={selected}
              data-active={selected || undefined} className={`${collection.row} ${row.kind === "Line" ? styles.line : styles.row}`}
              {...(row.kind === "Line" && row.fall !== null ? { "data-fall": "", style: { animationDelay: `calc(${row.fall} * var(--duration-instant) * 0.4)` } } : {})}>
              <div role="gridcell" id={cellId(row.key)} aria-label={name} className={styles.cell}
                onClick={event => click(row, event)}>{content}</div>
            </div>;
            switch (row.kind) {
              case "Commit": {
                const [only, ...more] = row.links;
                return more.length === 0
                  ? cell(`import ${linkPointer(only!)}`, <><Import size={18} aria-hidden="true" className={styles.glyph} /><span className={styles.label}>import <span className={styles.mono}>{linkPointer(only!)}</span></span></>)
                  : cell(`import ${row.links.length} links`, <><Import size={18} aria-hidden="true" className={styles.glyph} /><span className={styles.label}>import {row.links.length} links</span></>);
              }
              case "Line": {
                const view = viewOf(row.line);
                return cell(lineName(view), <ImportLine line={row.line} view={view} tabbable={selected || mobile}
                  onVerb={verb => press(row.line, verb)}
                  onDismiss={() => view.dismiss === "Stop" ? intake.stop(row.line.id) : intake.remove(row.line.id)}>
                  {view.menu === null ? null : <ContextualActionMenu title={view.one.text} subjectKey={`import-line:${row.line.id}`}
                    sections={[]} navigation={null} resourceRef={assumeCanonicalResourceRef(`media:${view.menu}`)}
                    label={`more actions for ${view.one.text}`} align="end" triggerAttributes={{ tabIndex }}
                    returnFocusTo={() => inputRef.current}
                    renderTrigger={trigger => <OverflowMenuButton {...trigger} className={styles.menu} />} />}
                </ImportLine>);
              }
              case "Choose": return cell("choose a file…", <><Import size={18} aria-hidden="true" className={styles.glyph} /><span className={styles.label}>choose a file…</span></>);
              case "Shelf": {
                const readable = row.item.can_read || row.item.can_play;
                const one = readable ? row.item.title : row.item.source_label ?? row.item.original_filename ?? row.item.title;
                const two = shelfLine(row.item);
                return cell(`${one}, ${two.replaceAll(" · ", ", ")}`, <div className={styles.lineText}>
                  <div className={styles.one}><span className={readable ? styles.title : styles.pointer}>{one}</span></div>
                  <div className={styles.two}>{two}</div>
                </div>);
              }
              case "All": return cell(attention > 0 ? `all imports, ${attentionPhrase(attention)}` : "all imports", <>
                <AllImports size={18} aria-hidden="true" className={styles.glyph} />
                <span className={styles.label}>all imports</span>
                {attention > 0 ? <span className={styles.end}>{attentionPhrase(attention)}</span> : null}
              </>);
            }
          })}
        </div>
      </div>
      <input ref={filesRef} type="file" multiple hidden accept=".pdf,.epub,application/pdf,application/epub+zip"
        onChange={event => {
          const files = [...event.currentTarget.files ?? []];
          event.currentTarget.value = "";
          admitFiles(files);
          inputRef.current?.focus();
        }} />
      <input ref={againRef} type="file" hidden accept=".pdf,.epub,application/pdf,application/epub+zip"
        onChange={event => {
          const file = event.currentTarget.files?.[0] ?? null;
          const id = again.current;
          event.currentTarget.value = "";
          again.current = null;
          if (file !== null && id !== null) intake.reselect(id, file);
          inputRef.current?.focus();
        }} />
    </section>
  );
}

/** Where a shelf row leads: the work once it reads, else its import in all imports. */
function shelfTarget(item: ImportItem): WorkspaceTarget {
  return item.media_id !== null && (item.can_read || item.can_play)
    ? { href: `/media/${item.media_id}`, labelHint: item.title }
    : { href: `/imports?${encodeImportsUrl({ selected: item.ref })}`, secondaryActivation: { surfaceId: "import-detail" } };
}

/** A shelf row's line two: its kind once it reads, else what is true of the obligation that
 * speaks. Only a source failure says `couldn’t read this`; search and metadata get fixed words. */
function shelfLine(item: ImportItem): string {
  const kind = mediaKindLabel(item.media_kind);
  const readable = item.can_read || item.can_play;
  switch (item.classification) {
    case "Complete": return kind;
    case "Active": return readable ? kind : "importing…";
    case "NeedsAttention": switch (item.primary) {
      case "search": return `${kind} · search indexing stopped`;
      case "metadata": {
        const operation = item.obligations.metadata?.operation ?? null;
        return operation?.status === "failed" ? `${kind} · ${metadataOperationName(operation.purpose)} stopped` : `${kind} · no metadata found`;
      }
      case "source": case null: {
        const source = item.obligations.source;
        const code = source?.failure_code ?? null;
        // the upload stage's only attention state is an expired window
        if (source?.stage === "Upload") return "upload timed out";
        if (item.media_id === null) return code === null ? "couldn’t read this" : FAILURE_COPY[code].reason;
        if (readable) return code === null ? `${kind} · needs attention` : `${kind} · ${FAILURE_COPY[code].reason}`;
        const reason = reasonLine(item);
        return reason === null ? "couldn’t read this" : `couldn’t read this · ${reason}`;
      }
    }
  }
}
