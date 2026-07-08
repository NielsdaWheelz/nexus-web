"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSearchResultPage } from "@/lib/search/searchApi";
import type { SearchQuery } from "@/lib/search/query";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import styles from "./CitePicker.module.css";

const DEBOUNCE_MS = 200;
const PAGE_LIMIT = 20;

/**
 * The citable ref for a search row (§4.5): a passage cites its `evidence_span`,
 * a whole work cites its `media`. The search intent-model deleted the
 * `result_types` param, so scoping is client-side over the `documents` kind
 * (rebase deviation from D-10): content-chunk rows become span/media citations,
 * a bare evidence_span row cites itself, media/fragment/episode/video rows
 * become whole-work citations, everything else is uncitable and filtered out.
 */
export function citableRefForRow(row: SearchResultRowViewModel): string | null {
  if (row.type === "evidence_span") {
    const spanId = row.contextRef?.id;
    return spanId ? `evidence_span:${spanId}` : null;
  }
  if (row.type === "content_chunk") {
    const spanId = row.contextRef?.evidenceSpanIds[0];
    if (spanId) return `evidence_span:${spanId}`;
    return row.mediaId ? `media:${row.mediaId}` : null;
  }
  if (row.type === "media" || row.type === "fragment" || row.type === "episode" || row.type === "video") {
    return row.mediaId ? `media:${row.mediaId}` : null;
  }
  return null;
}

interface CitableRow {
  row: SearchResultRowViewModel;
  ref: string;
}

export interface CitePickerProps {
  onPick: (targetRef: string) => void;
  onClose: () => void;
}

export default function CitePicker({ onPick, onClose }: CitePickerProps) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<CitableRow[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = useMemo<SearchQuery>(
    () => ({
      text,
      requestedKinds: new Set(["documents"]),
      formats: [],
      authors: [],
      roles: [],
      scope: "all",
    }),
    [text],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (text.trim().length === 0) {
      setRows([]);
      setActive(0);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const page = await fetchSearchResultPage(query, {
          limit: PAGE_LIMIT,
          signal: controller.signal,
        });
        const citable: CitableRow[] = [];
        for (const row of page.rows) {
          const ref = citableRefForRow(row);
          if (ref) citable.push({ row, ref });
        }
        setRows(citable);
        setActive(0);
      } catch {
        // justify-ignore: an aborted/failed page leaves the prior rows; the next
        // keystroke retries. No user-facing error surface for a picker fetch.
      }
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, text]);

  return (
    <div className={styles.picker} role="dialog" aria-label="Cite a passage" data-testid="cite-picker">
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        placeholder="Cite a passage or work…"
        value={text}
        aria-label="Cite search"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, rows.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const picked = rows[active];
            if (picked) onPick(picked.ref);
          }
        }}
      />
      <ul className={styles.results} role="listbox" aria-label="Cite results">
        {rows.map((entry, index) => (
          <li key={entry.row.key} role="option" aria-selected={index === active}>
            <button
              type="button"
              className={`${styles.result} ${index === active ? styles.resultActive : ""}`}
              data-testid="cite-result"
              data-ref={entry.ref}
              onMouseEnter={() => setActive(index)}
              onClick={() => onPick(entry.ref)}
            >
              <span className={styles.resultTitle}>{entry.row.primaryText}</span>
              {entry.row.sourceMeta ? (
                <span className={styles.resultMeta}>{entry.row.sourceMeta}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
