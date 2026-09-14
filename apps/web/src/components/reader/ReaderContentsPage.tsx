import { useLayoutEffect, useRef } from "react";
import { readerCapacityNotice } from "@/lib/reader/readerCapacity";
import type { ReaderContents } from "@/lib/reader/useReaderContents";
import ReaderContentBoundary from "./ReaderContentBoundary";
import styles from "./ReaderContentsPage.module.css";

/** Keep this leaf within useReaderContents' four-node row and fixed chrome budget. */
export default function ReaderContentsPage({ contents, activeSectionId, onNavigate }: {
  readonly contents: ReaderContents;
  readonly activeSectionId: string | null;
  readonly onNavigate: (sectionId: string) => void;
}) {
  const state = contents.state;
  const notice = state.kind === "Capacity" ? readerCapacityNotice(state.reason) : null;
  const listRoot = useRef<HTMLDivElement>(null);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  useLayoutEffect(() => {
    const host = listRoot.current;
    if (host === null || state.kind !== "Ready" || state.released) return;
    const release = state.retain();
    let list: HTMLUListElement | null = document.createElement("ul");
    list.className = styles.tocList;
    try {
      const page = state.page;
      for (const entry of page.toc.length > 0 ? page.toc : page.sections) {
        const depth = Math.max(0, entry.depth ?? entry.level ?? 0);
        const item = document.createElement("li");
        item.className = styles.tocItem;
        item.setAttribute("aria-level", String(depth + 1));
        const sectionId = entry.section_id;
        if (sectionId === null) {
          const label = document.createElement("span");
          label.className = styles.tocLabel;
          label.textContent = entry.label;
          item.append(label);
        } else {
          const button = document.createElement("button");
          button.type = "button";
          button.className = styles.tocLink;
          button.dataset.sectionId = sectionId;
          button.style.paddingInlineStart = `calc(var(--space-2) + ${depth} * var(--space-3))`;
          button.textContent = entry.label;
          button.onclick = () => { if (!state.released) navigate.current(sectionId); };
          item.append(button);
        }
        list.append(item);
      }
      host.append(list);
    } catch (error) { list?.remove(); list = null; release(); throw error; }
    return () => { list?.remove(); list = null; release(); };
  }, [state]);
  useLayoutEffect(() => {
    listRoot.current?.querySelectorAll<HTMLButtonElement>("button[data-section-id]").forEach((button) => {
      const active = button.dataset.sectionId === activeSectionId;
      button.classList.toggle(styles.tocActive, active);
      if (active) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    });
  }, [activeSectionId, state]);
  return <ReaderContentBoundary defect={contents.defect} ready={state.kind === "Ready"} retry={contents.retry}>
    <nav aria-label="Document contents" aria-busy={state.kind === "Loading"}>
      {state.kind === "Loading" ? <p>Loading contents…</p> : null}
      {notice !== null ? <p role="status">{notice.message}</p> : null}
      {state.kind === "Failed" && contents.defect === null ? <p role="alert">Contents could not be loaded.</p> : null}
      {/* Source levels remain explicit when a parent is on another contents page. */}
      <div ref={listRoot} />
      <div>
        {!contents.isFirst ? <button type="button" onClick={contents.first}>First contents page</button> : null}
        {contents.hasPrevious ? <button type="button" onClick={contents.previous}>Previous contents page</button> : null}
        {state.kind === "Ready" && state.page.next_ref !== null ? <button type="button" onClick={contents.next}>More contents</button> : null}
        {(notice !== null && notice.retryable) || (state.kind === "Failed" && contents.defect === null)
          ? <button type="button" onClick={contents.retry}>Retry contents</button> : null}
      </div>
    </nav>
  </ReaderContentBoundary>;
}
