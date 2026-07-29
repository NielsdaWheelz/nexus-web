"use client";

import { ArrowLeft } from "lucide-react";
import { useRef, type MouseEvent } from "react";
import Input from "@/components/ui/Input";
import type { DesktopNexusController } from "./types";
import styles from "./desktopNexus.module.css";

const webOptionId = (id: string) => `desktop-nexus-web-option-${id}`;

export default function DesktopNexusWebSearch({
  controller,
}: {
  controller: DesktopNexusController;
}) {
  const composing = useRef(false);
  if (controller.page.kind !== "WebSearch") return null;
  const { page } = controller;
  const activeIndex = page.results.findIndex(
    (result) => result.id === controller.activeWebResultId,
  );
  const moveActive = (delta: number) => {
    if (page.results.length === 0) return;
    const start = activeIndex < 0 ? 0 : activeIndex;
    const next = Math.max(0, Math.min(page.results.length - 1, start + delta));
    controller.setActiveWebResult(page.results[next]!.id);
  };
  const select = (event: MouseEvent<HTMLDivElement>, id: string) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    controller.selectWebResult(
      id,
      event.shiftKey ? "Fork" : "Follow",
      "Pointer",
    );
  };
  return (
    <section className={styles.webPage} aria-label="Web Search">
      <header className={styles.pageHeader}>
        <button type="button" className={styles.backButton} onClick={controller.back} aria-label="Back to Nexus">
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <h2>Web Search</h2>
      </header>
      <label className={styles.webInputRow}>
        <span className="sr-only">Search the web</span>
        <Input
          variant="bare"
          role="combobox"
          aria-label="Search the web"
          aria-autocomplete="list"
          aria-controls="desktop-nexus-web-results"
          aria-expanded="true"
          aria-activedescendant={
            controller.activeWebResultId
              ? webOptionId(controller.activeWebResultId)
              : undefined
          }
          className={styles.input}
          value={page.query}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => controller.setWebQuery(event.currentTarget.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActive(1);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActive(-1);
              return;
            }
            if (event.key === "Enter" && controller.activeWebResultId) {
              event.preventDefault();
              controller.selectWebResult(
                controller.activeWebResultId,
                event.shiftKey ? "Fork" : "Follow",
                "Keyboard",
              );
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              controller.back();
            }
          }}
        />
      </label>
      <p className={styles.webQuery}>Results for “{page.query}”</p>
      {page.status === "Loading" ? <p className={styles.status}>Searching the web…</p> : null}
      {page.status === "RetryableFailure" ? (
        <p className={styles.status}>Couldn’t search the web. <button type="button" onClick={() => controller.retry("Web")}>Retry</button></p>
      ) : null}
      {page.status === "Ready" && page.results.length === 0 ? <p className={styles.empty}>No web results for “{page.query}”</p> : null}
      <div id="desktop-nexus-web-results" className={styles.list} role="listbox" aria-label="Web Search results">
        {page.results.map((result) => (
          <div
            key={result.id}
            id={webOptionId(result.id)}
            role="option"
            aria-selected={result.id === controller.activeWebResultId}
            aria-label={[result.title, result.source, result.excerpt].filter(Boolean).join(". ")}
            className={styles.option}
            data-active={result.id === controller.activeWebResultId || undefined}
            onMouseMove={() => controller.setActiveWebResult(result.id)}
            onClick={(event) => select(event, result.id)}
          >
            <span className={styles.optionBody}>
              <span className={styles.optionLabel}>{result.title}</span>
              <span className={styles.optionMeta}>{result.source}</span>
              {result.excerpt ? <span className={styles.optionExcerpt}>{result.excerpt}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
