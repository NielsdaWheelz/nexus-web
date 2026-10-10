"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import MachineText from "@/components/ui/MachineText";
import type { Message } from "@/lib/chat/wire";
import type { PaneRuntimeContextValue } from "@/lib/panes/paneRuntime";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import styles from "./ChatPanels.module.css";

// "Walk the sources": step through an answer's citations, driving the pane to
// each source while the sentence that cites it stays in view.

type Step = { title: string; href: string | null; sentence: string | null };
type Move = "next" | "prev" | "leave";
const KEYS: Record<string, Move> = {
  n: "next",
  ArrowRight: "next",
  p: "prev",
  ArrowLeft: "prev",
  Escape: "leave",
};

/** The sentence holding `[ordinal]`, unless it falls inside inline code. */
function citingSentence(text: string, ordinal: number): string | null {
  const marker = `[^.\\n]*\\[${ordinal}\\](?!\\()[^.\\n]*\\.?`;
  const sentence = new RegExp(marker).exec(text)?.[0].trim();
  return sentence && sentence.split("`").length % 2 ? sentence : null;
}

export function useDocentWalk(
  activateTarget: PaneRuntimeContextValue["activateTarget"],
) {
  const [walk, setWalk] = useState({
    steps: [] as Step[],
    index: 0,
    active: false,
  });
  const start = useCallback((message: Message) => {
    const steps = [...message.citations]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((citation) => ({
        title: citation.snapshot?.title ?? "Untitled source",
        href: citation.deep_link,
        sentence: citingSentence(message.content, citation.ordinal),
      }));
    setWalk({ steps, index: 0, active: true });
  }, []);
  const go = useCallback((move: Move) => {
    setWalk((w) => {
      const index = w.index + (move === "next" ? 1 : move === "prev" ? -1 : 0);
      const active = move !== "leave" && index < w.steps.length;
      return {
        ...w,
        index: Math.max(0, Math.min(index, w.steps.length - 1)),
        active,
      };
    });
  }, []);

  const activate = useRef(activateTarget);
  activate.current = activateTarget;
  const step = walk.active ? walk.steps[walk.index] : undefined;
  useEffect(() => {
    if (step?.href)
      activate.current({
        target: { href: step.href, labelHint: step.title },
        disposition: { kind: "Adopt" },
      });
  }, [step]);
  useEffect(() => {
    if (!walk.active) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing =
        target?.isContentEditable ||
        /^(INPUT|TEXTAREA)$/.test(target?.tagName ?? "");
      if (event.defaultPrevented || hasActiveInteractionOwner() || typing)
        return;
      if (!KEYS[event.key]) return;
      event.preventDefault();
      go(KEYS[event.key]);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [walk.active, go]);
  return { walk, start, go };
}

export function DocentOverlay({
  docent: { walk, go },
}: {
  docent: ReturnType<typeof useDocentWalk>;
}) {
  const step = walk.active ? walk.steps[walk.index] : undefined;
  if (!step) return null;
  const controls: [Move, string, string][] = [
    ["prev", "Previous source", "← prev"],
    ["next", "Next source", "next →"],
    ["leave", "Leave walk", "✕ Leave"],
  ];
  return (
    <div className={styles.docent} role="status">
      <div aria-live="polite">
        <span className={styles.kicker}>
          {walk.index + 1} / {walk.steps.length}
        </span>{" "}
        · <strong>{step.title}</strong>
      </div>
      <div className={styles.sentence}>
        {step.href === null ? (
          <span className={styles.faint}>Source unavailable</span>
        ) : step.sentence ? (
          <MachineText variant="inline" origin={{ label: "Assistant" }}>
            {step.sentence}
          </MachineText>
        ) : (
          <span aria-hidden="true">—</span>
        )}
      </div>
      <div className={styles.docentControls}>
        {controls.map(([move, label, text]) => (
          <Button
            key={move}
            variant="ghost"
            size="sm"
            disabled={move === "prev" && walk.index === 0}
            aria-label={label}
            onClick={() => go(move)}
          >
            {text}
          </Button>
        ))}
      </div>
    </div>
  );
}
