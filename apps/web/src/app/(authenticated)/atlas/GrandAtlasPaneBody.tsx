"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { useResource } from "@/lib/api/useResource";
import type { ApiJson } from "@/lib/api/wire";
import { failureCopy } from "@/lib/oracle/oracle";
import {
  requirePaneRuntime,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { OracleTheme } from "../oracle/ornaments";
import styles from "./atlas.module.css";
import {
  corpusStar,
  drawSky,
  fitCanvas,
  folioStar,
  spanningTree,
  toScreen,
  type Scene,
  type Star,
} from "./sky";

const IDLE_TURN_PER_SECOND = (0.5 * Math.PI) / 180;
const HIT_RADIUS = 22;

export default function GrandAtlasPaneBody() {
  const { activateTarget } = requirePaneRuntime(
    usePaneRuntime(),
    "GrandAtlasPaneBody",
  );
  const fromLanding = usePaneSearchParams().get("layer") === "readings";
  const [layers, setLayers] = useState({ corpus: true, readings: fromLanding });
  const [hovered, setHovered] = useState<Star | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const atlas = useResource<ApiJson<"/atlas", "get">>({
    cacheKey: "atlas",
    path: () => "/api/atlas",
  });
  // The readings layer loads when first shown; a folio's first tap loads its peers.
  const readings = useResource<ApiJson<"/oracle/readings", "get">>({
    cacheKey: layers.readings ? "oracle-readings" : null,
    path: () => "/api/oracle/readings",
  });
  const concordance = useResource<
    ApiJson<"/oracle/readings/{reading_id}/concordance", "get">
  >({
    cacheKey: selected === null ? null : `concordance:${selected}`,
    path: () => `/api/oracle/readings/${selected}/concordance`,
  });
  const sky = atlas.status === "ready" ? atlas.data.data : null;
  const peers =
    concordance.status === "ready"
      ? concordance.data.data.map((peer) => peer.id)
      : [];

  const corpus = useMemo(() => sky?.stars.map(corpusStar) ?? [], [sky]);
  const folios = useMemo(
    () =>
      readings.status === "ready" ? readings.data.data.map(folioStar) : [],
    [readings],
  );
  const tree = useMemo(() => {
    const at = new Map(
      corpus.filter((star) => !star.nebula).map((star) => [star.id, star.at]),
    );
    return (sky?.constellations ?? []).flatMap((c) =>
      spanningTree(c.member_media_ids, at),
    );
  }, [sky, corpus]);
  const stars = [
    ...(layers.corpus ? corpus : []),
    ...(layers.readings ? folios : []),
  ];

  // The animation loop reads the latest scene through a ref, never re-subscribing.
  const latest: Scene = {
    stars,
    edges: layers.corpus ? (sky?.edges ?? []) : [],
    constellations: layers.corpus ? (sky?.constellations ?? []) : [],
    tree: layers.corpus ? tree : [],
    hovered: hovered?.id ?? null,
    selected,
    peers,
  };
  const scene = useRef(latest);
  scene.current = latest;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const camera = useRef(0);
  const drag = useRef<{
    pointer: number;
    startX: number;
    startY: number;
    lastX: number;
  } | null>(null);
  const screen = () =>
    canvasRef.current && frameRef.current
      ? fitCanvas(canvasRef.current, frameRef.current, camera.current)
      : null;
  const screenRef = useRef(screen);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let last = 0;
    let raf = 0;
    const tick = (now: number) => {
      const still = reduced.matches;
      if (!drag.current && !still && last > 0) {
        camera.current =
          (camera.current + (IDLE_TURN_PER_SECOND * (now - last)) / 1000) %
          (Math.PI * 2);
      }
      last = now;
      const s = screenRef.current();
      if (s) drawSky(ctx, s, scene.current, still ? 0 : now / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const hit = (clientX: number, clientY: number): Star | null => {
    const s = screen();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!s || !rect) return null;
    let nearest: Star | null = null;
    let best = HIT_RADIUS ** 2;
    for (const star of scene.current.stars) {
      const pos = toScreen(star.at, s);
      const distance =
        (pos.x - (clientX - rect.left)) ** 2 +
        (pos.y - (clientY - rect.top)) ** 2;
      if (distance < best) [nearest, best] = [star, distance];
    }
    return nearest;
  };

  const choose = (star: Star | null) => {
    if (star?.layer === "corpus") {
      activateTarget({
        target: { href: `/media/${star.id}` },
        disposition: { kind: "Follow" },
      });
    } else if (star !== null && scene.current.selected === star.id) {
      // A folio's first tap traces its concordance; the second enters it.
      activateTarget({
        target: { href: `/oracle/${star.id}` },
        disposition: { kind: "Follow" },
      });
    } else {
      scene.current = { ...scene.current, selected: star?.id ?? null };
      setSelected(star?.id ?? null);
    }
  };

  const errors = [
    atlas.status === "error" &&
      failureCopy(atlas.error, "The Atlas couldn’t be loaded"),
    readings.status === "error" &&
      failureCopy(readings.error, "The readings layer couldn’t be loaded"),
  ].filter((error): error is FeedbackContent => error !== false);
  const count = corpus.length;

  return (
    <OracleTheme>
      <div className={styles.surface}>
        <div className={styles.headline}>
          <span className={styles.title}>The Atlas</span>
          <span className={styles.gold}>·</span>
          <span className={styles.subtitle}>
            {sky === null && atlas.status !== "error"
              ? "charting the corpus…"
              : `${count} ${count === 1 ? "star" : "stars"}`}
          </span>
        </div>
        {errors.map((error) => (
          <FeedbackNotice
            key={error.title}
            content={error}
            announcement="Assertive"
          />
        ))}

        <div ref={frameRef} className={styles.frame}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            role="img"
            aria-label="A celestial chart of the whole library"
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              const { pointerId: pointer, clientX, clientY } = event;
              drag.current = {
                pointer,
                startX: clientX,
                startY: clientY,
                lastX: clientX,
              };
            }}
            onPointerMove={(event) => {
              const d = drag.current;
              if (d?.pointer !== event.pointerId)
                return setHovered(hit(event.clientX, event.clientY));
              const turn =
                ((event.clientX - d.lastX) / event.currentTarget.clientWidth) *
                Math.PI *
                2;
              camera.current =
                (camera.current - turn + Math.PI * 4) % (Math.PI * 2);
              d.lastX = event.clientX;
            }}
            onPointerUp={(event) => {
              const d = drag.current;
              if (d?.pointer !== event.pointerId) return;
              drag.current = null;
              if (
                Math.hypot(event.clientX - d.startX, event.clientY - d.startY) <
                4
              )
                choose(hit(event.clientX, event.clientY));
            }}
            onPointerCancel={() => (drag.current = null)}
            onPointerLeave={() => {
              drag.current = null;
              setHovered(null);
            }}
          />

          {hovered && (
            <div className={styles.label} aria-live="polite">
              {hovered.corpus ? (
                <>
                  <span className={styles.labelTitle}>
                    {hovered.corpus.title}
                  </span>
                  <span className={styles.labelKind}>
                    {hovered.corpus.kind} · {hovered.corpus.magnitude}{" "}
                    {hovered.corpus.magnitude === 1
                      ? "highlight"
                      : "highlights"}
                  </span>
                </>
              ) : (
                <>
                  <span className={styles.labelFolio}>
                    Folio {hovered.folio?.folio_number}
                  </span>
                  {hovered.folio?.folio_motto && (
                    <span className={styles.labelTitle}>
                      {hovered.folio.folio_motto}
                    </span>
                  )}
                  {selected === hovered.id && (
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
                  setLayers((current) => ({
                    ...current,
                    [layer]: !current[layer],
                  }))
                }
              >
                {layer === "corpus" ? "Corpus" : "Readings"}
              </button>
            ))}
          </div>
          <div className={styles.legend}>
            Drag to turn the sky · click a star to open the work
          </div>
          <ul className={styles.srOnly}>
            {corpus.map((star) => (
              <li key={star.id}>
                <a href={`/media/${star.id}`}>
                  {star.corpus?.title} ({star.corpus?.kind})
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </OracleTheme>
  );
}
