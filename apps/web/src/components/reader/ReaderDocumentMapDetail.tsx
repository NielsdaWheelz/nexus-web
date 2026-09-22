"use client";

import { useState } from "react";
import { absent, present, type Presence } from "@/lib/api/presence";
import type { MediaNavigation } from "@/lib/media/readerNavigation";
import type {
  ReaderDocumentMapMarker,
  ReaderMapMarkerPresentation,
} from "@/lib/reader/documentMap";
import {
  projectReaderLocalPoint,
  readerSectionAtPosition,
  type ReaderDocumentOverviewRange,
  type ReaderDocumentStructure,
  type ReaderPositionedSection,
} from "@/lib/reader/readerDocumentPosition";
import ReaderContentsNav from "./ReaderContentsNav";
import ReaderDocumentMapOverviewRail from "./ReaderDocumentMapOverviewRail";
import styles from "./ReaderDocumentMapDetail.module.css";

type DetailScope = { kind: "Document" } | { kind: "Section"; sectionId: string };

export default function ReaderDocumentMapDetail({
  navigation,
  structure,
  currentOffset,
  visibleRange,
  destinations,
  onNavigateSection,
  onActivateMarker,
  onRevealCurrent,
  onReturn,
}: {
  navigation: MediaNavigation;
  structure: ReaderDocumentStructure;
  currentOffset: Presence<number>;
  visibleRange: Presence<ReaderDocumentOverviewRange>;
  destinations: readonly ReaderMapMarkerPresentation[];
  onNavigateSection: (sectionId: string) => void;
  onActivateMarker: (marker: ReaderDocumentMapMarker) => void;
  onRevealCurrent: () => void;
  onReturn: Presence<() => void>;
}) {
  const currentSection = currentOffset.kind === "Present" ? readerSectionAtPosition(structure, currentOffset.value) : absent<ReaderPositionedSection>();
  const [selection, setSelection] = useState<DetailScope>(() => currentSection.kind === "Present"
    ? { kind: "Section", sectionId: currentSection.value.section.section_id }
    : { kind: "Document" });
  const selectedSection = selection.kind === "Section"
    ? structure.sections.find((entry) => entry.section.section_id === selection.sectionId)
    : undefined;
  if (selection.kind === "Section" && !selectedSection) {
    throw new Error("Selected map section is absent from the current source.");
  }
  const scope = selectedSection?.extent.kind === "Present"
    ? { ...selectedSection.extent.value, label: selectedSection.section.label }
    : { start: 0, end: structure.length, label: "document" };
  const ancestors: ReaderPositionedSection[] = [];
  let ancestor = selectedSection;
  while (ancestor) {
    ancestors.unshift(ancestor);
    const parent = ancestor.section.parent_section_id;
    ancestor = parent.kind === "Present" ? structure.sections.find((entry) => entry.section.section_id === parent.value) : undefined;
  }
  const local = currentOffset.kind === "Present"
    ? projectReaderLocalPoint({ scope, position: currentOffset.value, documentLength: structure.length })
    : absent<number>();
  const currentPosition = currentOffset.kind === "Present" && structure.length > 0
    ? present(currentOffset.value / structure.length)
    : absent<number>();

  return (
    <section className={styles.detail} aria-label="Document map">
      <nav className={styles.breadcrumb} aria-label="Map scope">
        <button type="button" aria-current={selection.kind === "Document" ? "location" : undefined} onClick={() => setSelection({ kind: "Document" })}>document</button>
        {ancestors.map((entry) => (
          <button key={entry.section.section_id} type="button" disabled={entry.extent.kind === "Absent" || entry.extent.value.end <= entry.extent.value.start} aria-current={entry.section.section_id === selectedSection?.section.section_id ? "location" : undefined} onClick={() => setSelection({ kind: "Section", sectionId: entry.section.section_id })}>
            {entry.section.label}
          </button>
        ))}
        {currentSection.kind === "Present" && currentSection.value.section.section_id !== selectedSection?.section.section_id ? (
          <button type="button" onClick={() => setSelection({ kind: "Section", sectionId: currentSection.value.section.section_id })}>current section</button>
        ) : null}
      </nav>
      <div className={styles.position}>
        {structure.length === 0 ? <span>text position unavailable</span> : (
          <>
            <span>{currentPosition.kind === "Present" ? `document ${Math.round(currentPosition.value * 100)}%` : "position unavailable"}</span>
            {selection.kind === "Section" ? <span>{local.kind === "Present" ? `section ${Math.round(local.value * 100)}%` : "outside this section"}</span> : null}
          </>
        )}
        {onReturn.kind === "Present" ? <button type="button" onClick={onReturn.value}>return to reading position</button> : null}
      </div>
      <div className={styles.content}>
        <div className={styles.outline}>
          <ReaderContentsNav
            nodes={navigation.toc_nodes}
            sections={navigation.sections}
            activeSectionId={currentSection.kind === "Present" ? present(currentSection.value.section.section_id) : absent()}
            onNavigate={onNavigateSection}
          />
          {navigation.sections.length === 0 ? <p className={styles.notice}>no sections in this document</p> : null}
        </div>
        {structure.length > 0 ? (
          <div className={styles.map}>
            <ReaderDocumentMapOverviewRail
              destinations={destinations}
              structure={present(structure)}
              visibleRange={visibleRange}
              currentPosition={currentPosition}
              scope={{ label: scope.label, start: scope.start / structure.length, end: scope.end / structure.length }}
              onActivateMarker={onActivateMarker}
              onRevealCurrent={onRevealCurrent}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
