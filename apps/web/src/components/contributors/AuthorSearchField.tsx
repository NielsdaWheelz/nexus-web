"use client";

// Author identity is independent of spelling: an existing handle is selectable
// once, while a matching name offers exactly one explicit distinct-person action.
import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import Input from "@/components/ui/Input";
import { useSettled } from "@/lib/api/serverState";
import { usePaneFreeServerList } from "@/lib/api/useServerList";
import { searchContributors, type ContributorSearchItem } from "@/lib/contributors/api";
import { contributorNameKey } from "@/lib/contributors/credits";
import { useOverlay } from "@/lib/ui/overlay";
import { reconcileSearchActive, useSearchOptions, type SearchActive } from "@/lib/ui/searchOptions";
import collection from "@/components/ui/Collection.module.css";
import styles from "./MediaAuthorsEditor.module.css";

const MAX_NAME_CODE_POINTS = 200;
type Option = { readonly key: string; readonly disabledReason: string | null } & (
  | { readonly kind: "Existing"; readonly item: ContributorSearchItem }
  | { readonly kind: "Create" | "CreateDistinct" }
);
const count = (n: number, unit: string) => `${new Intl.NumberFormat().format(n)} ${n === 1 ? unit : `${unit}s`}`;

export default function AuthorSearchField({ initialQuery, selectInitial, takenHandles, takenNewKeys, onSelectExisting, onCreateNew, onDismiss }: {
  readonly initialQuery: string;
  readonly selectInitial: boolean;
  readonly takenHandles: ReadonlySet<string>;
  readonly takenNewKeys: ReadonlySet<string>;
  readonly onSelectExisting: (item: ContributorSearchItem) => void;
  readonly onCreateNew: (displayName: string) => void;
  readonly onDismiss: () => void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState<SearchActive>(null);
  const trimmed = query.trim();
  const overLength = [...trimmed].length > MAX_NAME_CODE_POINTS;
  const searchable = trimmed !== "" && !overLength;
  const settled = useSettled(query, 180);
  const live = searchable && settled === query;
  const search = usePaneFreeServerList<ContributorSearchItem>({
    key: live ? `/contributors/search?q=${encodeURIComponent(trimmed)}` : null, stale: "", pageSize: 10, active: open && live,
    id: item => item.handle,
    fetchPage: (cursor, limit, signal) => searchContributors({ q: trimmed, cursor, limit, signal }),
  });
  const current = live && search.current;
  const failed = live && search.failure !== null && search.failure.op !== "More";
  const items = current ? search.items : [];
  useEffect(() => {
    inputRef.current?.focus();
    if (selectInitial) inputRef.current?.select();
    // Mount only: one field is mounted for each Add or Change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const options: Option[] = items.map(item => ({ key: item.handle, kind: "Existing", item,
    disabledReason: takenHandles.has(item.handle) ? "already added" : null }));
  if (current && searchable) {
    const nameKey = contributorNameKey(trimmed);
    const distinct = takenNewKeys.has(nameKey) || items.some(item => contributorNameKey(item.display_name) === nameKey);
    options.push({ key: "create", kind: distinct ? "CreateDistinct" : "Create", disabledReason: null });
  }
  const context = JSON.stringify([id, query]);
  const reconciled = reconcileSearchActive({ context, admitted: current, options,
    firstExistingKey: options.find(option => option.kind === "Existing" && option.disabledReason === null)?.key ?? null, active });
  useEffect(() => { if (active !== reconciled) setActive(reconciled); }, [active, reconciled]);
  const listVisible = open && (overLength || searchable);
  const bindings = useSearchOptions({ listId: `${id}-list`, label: "Authors", open: listVisible, options,
    activeKey: current ? reconciled?.key ?? null : null,
    onActiveChange: key => setActive({ context, key }),
    onActivate(key) {
      const option = current && open ? options.find(option => option.key === key) : null;
      if (!option || option.disabledReason !== null) return;
      if (option.kind === "Existing") onSelectExisting(option.item);
      else onCreateNew(trimmed);
    },
  });
  const status = overLength ? "a name can be up to 200 characters."
    : !searchable || failed ? "" : !current ? "searching…"
      : items.length === 0 ? search.complete ? "no matching authors" : "no matching authors found so far"
        : "";
  const readFeedback = useCollectionReadFeedback({
    list: search, unit: { singular: "author", plural: "authors" },
    waiting: listVisible && live && !failed && !current,
    outcome: items.length > 0 ? "results updated." : status,
    returnFocus: () => inputRef.current,
  });
  useOverlay(true, { kind: "transient", eligible: () => rootRef.current?.contains(document.activeElement) ?? false,
    onDismiss: () => { if (composing.current) return; if (listVisible) setOpen(false); else onDismiss(); },
  });
  return <div ref={rootRef} className={styles.search}>
    <label className="sr-only" htmlFor={`${id}-input`}>Search authors</label>
    <Input ref={inputRef} id={`${id}-input`} className={collection.search} {...bindings.inputProps}
      aria-describedby={`${id}-status`} value={query} dir="auto" placeholder="Search authors by name"
      autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => { if (bindings.handleKey(event.nativeEvent, composing.current)) { event.preventDefault(); event.stopPropagation(); } }} />
    <div id={`${id}-status`} className="sr-only">{status}</div>
    {listVisible && failed && search.failure !== null ? <FeedbackNotice
      content={{ tone: "Warning", title: "couldn’t load authors", requestId: search.failure.error.requestId }} announcement={search.active ? "Assertive" : "None"}
      actions={[{ label: "try again", onClick: search.retry, busy: search.running !== null }]} returnFocus={() => inputRef.current} /> : null}
    {listVisible && !failed && status && (overLength || items.length === 0) ? <FeedbackStatus
      content={{ tone: overLength ? "Warning" : "Neutral", title: status }} announcement={overLength || search.active && !current ? "Polite" : "None"} /> : null}
    {listVisible ? <div {...bindings.listProps} ref={bindings.listRef} className={`${collection.surface} ${collection.compactViewport}`}>
      {options.map(option => {
        const props = bindings.optionProps(option.key);
        return <div key={option.key} {...props} className={collection.row} aria-labelledby={`${props.id}-name`}
          aria-describedby={option.kind === "Existing" ? `${props.id}-detail` : undefined}>
          {option.kind === "Existing" ? <span className={collection.content}>
            <span id={`${props.id}-name`} dir="auto">{option.item.display_name}</span>
            <span id={`${props.id}-detail`} className={collection.detail}>
              {count(option.item.work_count, "work")}
              {option.item.work_examples.map((example, index) => <span key={example.href} dir="auto">{index === 0 ? " · " : ", "}{example.title}</span>)}
              {option.item.matched_alias ? <span dir="auto"> · also known as {option.item.matched_alias}</span> : null}
              {option.disabledReason ? ` · ${option.disabledReason}` : ""}
            </span>
          </span> : <><Plus size={16} className={collection.adornment} aria-hidden="true" /><span id={`${props.id}-name`} className={collection.content}>
            <span>{option.kind === "Create" ? <>create “<span dir="auto">{trimmed}</span>” as a new author</> : "create a different author with this name"}</span>
          </span></>}
        </div>;
      })}
    </div> : null}
    {listVisible ? readFeedback.notice : null}
    {readFeedback.announcement}
  </div>;
}
