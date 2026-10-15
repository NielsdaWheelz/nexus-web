"use client";

// The atlas pane: the viewer's sky (/atlas), the oracle's folios as a second
// layer (?layer=readings opens it), and what a pick means: a work opens in the
// pane; a folio's first pick traces its concordance, the second enters it.
import { useMemo, useRef, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import {
  usePaneFreeServerValue,
  useServerValue,
  type ServerValue,
  type Visit,
} from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { failureCopy, type OracleReadingSummary } from "@/lib/oracle/oracle";
import {
  requirePaneRuntime,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import { OracleTheme } from "../oracle/ornaments";
import styles from "./atlas.module.css";
import SkyCanvas from "./SkyCanvas";
import { corpusStar, folioStar, spanningTree, type Star } from "./sky";

const SKY = definePaneVisitDataKey<Visit<Schema<"AtlasOut">>>("Atlas.Sky");

/** The `data` of one GET. */
const read =
  <T,>(path: ApiPath) =>
  async (signal: AbortSignal) =>
    (await apiFetch<{ data: T }>(path, { signal })).data;

export default function GrandAtlasPaneBody() {
  const { activateTarget } = requirePaneRuntime(
    usePaneRuntime(),
    "GrandAtlasPaneBody",
  );
  const fromLanding = usePaneSearchParams().get("layer") === "readings";
  const [layers, setLayers] = useState({ corpus: true, readings: fromLanding });
  const [hovered, setHovered] = useState<Star | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const headline = useRef<HTMLDivElement>(null);

  const atlas = useServerValue({
    key: "/atlas",
    stale: "",
    visit: SKY,
    load: read<Schema<"AtlasOut">>("/api/atlas"),
  });
  // The readings layer loads when shown; a folio's first pick loads its peers.
  const readings = usePaneFreeServerValue({
    key: layers.readings ? "/oracle/readings" : null,
    stale: "",
    load: read<OracleReadingSummary[]>("/api/oracle/readings"),
  });
  const concordance = usePaneFreeServerValue({
    key: selected && `/oracle/readings/${selected}/concordance`,
    stale: "",
    load: read<Schema<"OracleConcordanceOut">[]>(
      `/api/oracle/readings/${selected}/concordance`,
    ),
  });
  const sky = atlas.status === "ready" ? atlas.data : null;
  const peers =
    concordance.status === "ready" ? concordance.data.map((p) => p.id) : [];

  const corpus = useMemo(() => sky?.stars.map(corpusStar) ?? [], [sky]);
  const folios = useMemo(
    () => (readings.status === "ready" ? readings.data.map(folioStar) : []),
    [readings],
  );
  const tree = useMemo(() => {
    const at = new Map(corpus.flatMap((s) => (s.nebula ? [] : [[s.id, s.at]])));
    return (sky?.constellations ?? []).flatMap((c) =>
      spanningTree(c.member_media_ids, at),
    );
  }, [sky, corpus]);
  const scene = {
    stars: [
      ...(layers.corpus ? corpus : []),
      ...(layers.readings ? folios : []),
    ],
    edges: (layers.corpus && sky?.edges) || [],
    constellations: (layers.corpus && sky?.constellations) || [],
    tree: layers.corpus ? tree : [],
    hovered: hovered?.id ?? null,
    selected,
    peers,
  };
  // Touch has no hover: the selected folio keeps its label, for a mouse too.
  const label =
    hovered ?? folios.find((folio) => folio.id === selected) ?? null;

  const open = (href: string) =>
    activateTarget({ target: { href }, disposition: { kind: "Follow" } });
  const pick = (star: Star | null) => {
    if (star?.layer === "corpus") open(`/media/${star.id}`);
    else if (star !== null && star.id === selected) open(`/oracle/${star.id}`);
    else setSelected(star?.id ?? null);
  };
  // A retried first load drops its notice, so Retry leaves focus on the headline.
  const retry = (value: ServerValue<unknown>) => () => {
    headline.current?.focus();
    value.refetch();
  };
  const failure = (value: ServerValue<unknown>, title: string) =>
    value.status === "failed" && (
      <FeedbackNotice
        key={title}
        content={failureCopy(value.error, title)}
        announcement="Assertive"
        actions={[{ label: "Retry", onClick: retry(value) }]}
      />
    );
  const count = corpus.length;

  return (
    <OracleTheme>
      <div className={styles.surface}>
        <div className={styles.headline} ref={headline} tabIndex={-1}>
          <span className={styles.title}>The Atlas</span>
          <span className={styles.gold}>·</span>
          <span className={styles.subtitle}>
            {atlas.status === "loading"
              ? "charting the corpus…"
              : `${count} ${count === 1 ? "star" : "stars"}`}
          </span>
        </div>
        {failure(atlas, "The Atlas couldn’t be loaded")}
        {failure(readings, "The readings layer couldn’t be loaded")}

        <div className={styles.frame}>
          <SkyCanvas scene={scene} onHover={setHovered} onPick={pick} />
          {label && (
            <div className={styles.label} aria-live="polite">
              {label.layer === "corpus" ? (
                <>
                  <span className={styles.labelTitle}>{label.work.title}</span>
                  <span className={styles.labelKind}>
                    {label.work.kind} · {label.work.magnitude}{" "}
                    {label.work.magnitude === 1 ? "highlight" : "highlights"}
                  </span>
                </>
              ) : (
                <>
                  <span className={styles.labelFolio}>
                    Folio {label.folio.folio_number}
                  </span>
                  {label.folio.folio_motto && (
                    <span className={styles.labelTitle}>
                      {label.folio.folio_motto}
                    </span>
                  )}
                  {selected === label.id && (
                    <span className={styles.labelHint}>
                      {peers.length > 0
                        ? `Constellation of ${peers.length} · click again to enter`
                        : "click again to enter"}
                    </span>
                  )}
                </>
              )}
            </div>
          )}
          <div className={styles.toggles}>
            {(["corpus", "readings"] as const).map((layer) => (
              <button
                key={layer}
                type="button"
                className={styles.toggle}
                aria-pressed={layers[layer]}
                onClick={() =>
                  setLayers((now) => ({ ...now, [layer]: !now[layer] }))
                }
              >
                {layer === "corpus" ? "Corpus" : "Readings"}
              </button>
            ))}
          </div>
          <div className={styles.legend}>
            Drag to turn the sky · click a star to open the work
          </div>
          {/* The visible layers for screen readers; a link opens in the pane. */}
          <ul className={styles.srOnly}>
            {scene.stars.map((star) => {
              const href =
                star.layer === "corpus"
                  ? `/media/${star.id}`
                  : `/oracle/${star.id}`;
              return (
                <li key={star.id}>
                  <a
                    href={href}
                    onClick={(event) => {
                      event.preventDefault();
                      open(href);
                    }}
                  >
                    {star.layer === "corpus"
                      ? `${star.work.title} (${star.work.kind})`
                      : `Folio ${star.folio.folio_number}${star.folio.folio_motto ? `: ${star.folio.folio_motto}` : ""}`}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </OracleTheme>
  );
}
