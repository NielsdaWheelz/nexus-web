"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackNotice, toFeedback } from "@/components/feedback/Feedback";
import { useApiResource } from "@/lib/api/useApiResource";
import { toRoman } from "@/lib/toRoman";
import { useStickyHeadline } from "../../OracleShell";
import styles from "./atlas.module.css";
import StarLabel from "./StarLabel";
import {
  placeFolios,
  projectToScreen,
  squaredDistance,
  starMagnitude,
  type FolioStar,
  type FolioStarInput,
  type StarMagnitude,
} from "./projection";

interface OracleSummary extends FolioStarInput {
  readonly plate_thumbnail_url: string | null;
  readonly plate_alt_text: string | null;
  readonly question_text: string;
}

interface ConcordanceEntry {
  readonly id: string;
  readonly folio_number: number;
  readonly folio_motto: string;
  readonly folio_theme: string | null;
  readonly shared_plate: boolean;
  readonly shared_theme: boolean;
  readonly shared_passage_count: number;
}

/** Drift speed of the celestial sphere, radians per second. ~0.5°/s. */
const IDLE_ROTATION_RAD_PER_SEC = (0.5 * Math.PI) / 180;
/** Hit-test radius around the pointer, in CSS pixels. */
const STAR_HIT_RADIUS_PX = 22;
/** How long the constellation lingers after click, before navigating. */
const SELECTION_LINGER_MS = 1100;


interface StarStyle {
  /** Solid disc radius in CSS pixels. */
  readonly core: number;
  /** Outer glow radius in CSS pixels. */
  readonly glow: number;
  /** Core fill alpha, 0..1. */
  readonly coreAlpha: number;
  /** Glow peak alpha at the core, 0..1. */
  readonly glowAlpha: number;
}

function styleForMagnitude(mag: StarMagnitude): StarStyle {
  switch (mag) {
    case "bright":
      return { core: 2.4, glow: 13, coreAlpha: 1, glowAlpha: 0.55 };
    case "glimmer":
      return { core: 1.6, glow: 9, coreAlpha: 0.75, glowAlpha: 0.3 };
    case "faint":
      return { core: 1.2, glow: 6, coreAlpha: 0.35, glowAlpha: 0.15 };
  }
}

const STAR_COLOR_BRIGHT = "243, 233, 208"; // --oracle-cream
const STAR_COLOR_GLIMMER = "195, 154, 77"; // --oracle-gold
const STAR_COLOR_FAINT = "107, 42, 42"; // --oracle-maroon

function starColor(mag: StarMagnitude): string {
  switch (mag) {
    case "bright":
      return STAR_COLOR_BRIGHT;
    case "glimmer":
      return STAR_COLOR_GLIMMER;
    case "faint":
      return STAR_COLOR_FAINT;
  }
}

interface DrawContext {
  readonly ctx: CanvasRenderingContext2D;
  readonly w: number;
  readonly h: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly cameraAzimuth: number;
  readonly time: number;
}

function drawDome(d: DrawContext): void {
  const { ctx, w, h, centerX, centerY, radius } = d;
  ctx.clearRect(0, 0, w, h);

  // A very faint, warm radial wash — the night-sky background.
  const wash = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
  wash.addColorStop(0, "rgba(38, 30, 24, 0.55)");
  wash.addColorStop(0.7, "rgba(20, 17, 15, 0)");
  wash.addColorStop(1, "rgba(20, 17, 15, 0)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);

  // Concentric altitude rings — the astrolabe's tropic lines. Subtle.
  ctx.strokeStyle = "rgba(74, 59, 42, 0.5)"; // --oracle-rule, dim
  ctx.lineWidth = 1;
  for (const frac of [1 / 3, 2 / 3]) {
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * frac, 0, Math.PI * 2);
    ctx.stroke();
  }

  // The horizon rim — slightly brighter so the dome reads as a dome.
  ctx.strokeStyle = "rgba(74, 59, 42, 1)";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.stroke();

  // A faint zenith dot at the exact center — the point directly above.
  ctx.fillStyle = "rgba(195, 154, 77, 0.35)";
  ctx.beginPath();
  ctx.arc(centerX, centerY, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawCardinal(d: DrawContext): void {
  // A small "✦" glyph drifting around the rim, marking the sky's original
  // azimuth-zero. Lets you see how far you've rotated.
  const { ctx, centerX, centerY, radius, cameraAzimuth } = d;
  const theta = -cameraAzimuth; // sky's north appears at angle (0 - camera)
  const x = centerX + (radius + 14) * Math.sin(theta);
  const y = centerY - (radius + 14) * Math.cos(theta);
  ctx.fillStyle = "rgba(142, 120, 72, 0.85)"; // --oracle-marginalia-fg
  ctx.font = '11px var(--font-oracle-display), serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("✦", x, y);
}

function drawStars(
  d: DrawContext,
  stars: readonly FolioStar[],
  hoveredId: string | null,
  selectedId: string | null,
): void {
  const { ctx, centerX, centerY, radius, cameraAzimuth, time } = d;
  for (const star of stars) {
    const pos = projectToScreen(star.celestial, cameraAzimuth, centerX, centerY, radius);
    const mag = starMagnitude(star.status);
    const styleBase = styleForMagnitude(mag);
    const color = starColor(mag);

    // Per-star twinkle: a slow, low-amplitude breath synced to the star's id.
    const phase = (star.folio_number * 0.37 + time * 0.5) % (Math.PI * 2);
    const twinkle = 0.85 + 0.15 * Math.sin(phase);

    const isHover = star.id === hoveredId;
    const isSelected = star.id === selectedId;
    const focusBoost = isSelected ? 1.6 : isHover ? 1.3 : 1.0;

    // Soft outer glow — what makes a star feel like a star, not a dot.
    const glow = ctx.createRadialGradient(
      pos.x,
      pos.y,
      0,
      pos.x,
      pos.y,
      styleBase.glow * focusBoost,
    );
    glow.addColorStop(0, `rgba(${color}, ${styleBase.glowAlpha * twinkle * focusBoost})`);
    glow.addColorStop(1, `rgba(${color}, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, styleBase.glow * focusBoost, 0, Math.PI * 2);
    ctx.fill();

    // Solid core.
    ctx.fillStyle = `rgba(${color}, ${styleBase.coreAlpha * twinkle})`;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, styleBase.core * focusBoost, 0, Math.PI * 2);
    ctx.fill();

    // Selected star wears a faint ring — the focus the constellation hangs from.
    if (isSelected) {
      ctx.strokeStyle = `rgba(195, 154, 77, 0.7)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, styleBase.core * focusBoost + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * Stroke a constellation: arcs from the selected star to each of its
 * concordance peers, with a draw-in animation driven by `progress`.
 */
function drawConstellation(
  d: DrawContext,
  stars: readonly FolioStar[],
  selectedId: string | null,
  peerIds: readonly string[],
  progress: number,
): void {
  if (!selectedId || peerIds.length === 0 || progress <= 0) return;
  const selected = stars.find((s) => s.id === selectedId);
  if (!selected) return;
  const { ctx, centerX, centerY, radius, cameraAzimuth } = d;
  const start = projectToScreen(selected.celestial, cameraAzimuth, centerX, centerY, radius);

  ctx.strokeStyle = `rgba(195, 154, 77, ${0.55 * Math.min(1, progress)})`;
  ctx.lineWidth = 0.75;
  ctx.setLineDash([2, 4]);

  for (const peerId of peerIds) {
    const peer = stars.find((s) => s.id === peerId);
    if (!peer) continue;
    const end = projectToScreen(peer.celestial, cameraAzimuth, centerX, centerY, radius);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    // Draw a fraction of the line based on progress, so it animates outward
    // from the selected star toward each peer.
    const t = Math.min(1, progress);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(start.x + dx * t, start.y + dy * t);
    ctx.stroke();
  }

  ctx.setLineDash([]);
}

export default function AtlasPaneBody() {
  const router = useRouter();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [peerIds, setPeerIds] = useState<readonly string[]>([]);
  const headlineRef = useStickyHeadline("The Atlas");
  const readingsResource = useApiResource<{ data: OracleSummary[] }>({
    cacheKey: "oracle-readings",
    path: () => "/api/oracle/readings",
  });
  const readings = readingsResource.status === "ready" ? readingsResource.data.data : null;
  const loadError =
    readingsResource.status === "error"
      ? toFeedback(readingsResource.error, {
          fallback: "The Atlas could not be loaded.",
        })
      : null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cameraAzimuthRef = useRef(0);
  const interactingRef = useRef(false);
  // Respect prefers-reduced-motion: if set, the sky holds still — drag still
  // rotates, but the idle drift and the twinkle freeze.
  const reducedMotionRef = useRef(false);
  // We track both the initial press (for tap-vs-drag detection on pointerup)
  // and the most recent move (for incremental rotation deltas).
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const lastFrameRef = useRef<number>(0);
  const selectionStartRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const selectionNavigationTimeoutRef = useRef<number | null>(null);

  const stars = useMemo<readonly FolioStar[]>(
    () => (readings ? placeFolios(readings) : []),
    [readings],
  );
  const starsRef = useRef(stars);
  starsRef.current = stars;

  const hoveredIdRef = useRef(hoveredId);
  hoveredIdRef.current = hoveredId;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const peerIdsRef = useRef(peerIds);
  peerIdsRef.current = peerIds;

  // Resolve the canvas geometry — DPR-aware, so lines stay crisp.
  const resolveGeometry = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return null;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(320, Math.floor(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const centerX = w / 2;
    const centerY = h / 2;
    const radius = Math.min(centerX, centerY) - 24;
    return { w, h, centerX, centerY, radius };
  }, []);

  // Resize observer — keep the canvas in sync with the container.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      resolveGeometry();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [resolveGeometry]);

  // Track prefers-reduced-motion so the idle rotation and twinkle can yield.
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      reducedMotionRef.current = mql.matches;
    };
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);

  // The render loop. Runs continuously so the sky drifts and the
  // constellations animate in. Drawing the dome + ~tens-of-stars per frame
  // is cheap; we don't need to be precious about RAF here.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const tick = (now: number) => {
      const last = lastFrameRef.current;
      const dt = last > 0 ? (now - last) / 1000 : 0;
      lastFrameRef.current = now;

      if (!interactingRef.current && !reducedMotionRef.current) {
        cameraAzimuthRef.current =
          (cameraAzimuthRef.current + IDLE_ROTATION_RAD_PER_SEC * dt) % (Math.PI * 2);
      }

      const geom = resolveGeometry();
      if (geom) {
        // Freeze the twinkle clock under reduced-motion so the stars are still.
        const time = reducedMotionRef.current ? 0 : now / 1000;
        const d: DrawContext = {
          ctx,
          ...geom,
          cameraAzimuth: cameraAzimuthRef.current,
          time,
        };
        drawDome(d);
        drawCardinal(d);

        // Constellation draw-in: scales from 0 → 1 over ~600ms after selection.
        let progress = 0;
        if (selectionStartRef.current !== null) {
          progress = Math.min(1, (now - selectionStartRef.current) / 600);
        }
        drawConstellation(d, starsRef.current, selectedIdRef.current, peerIdsRef.current, progress);
        drawStars(d, starsRef.current, hoveredIdRef.current, selectedIdRef.current);
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastFrameRef.current = 0;
    };
  }, [resolveGeometry]);

  // Hit-test: which star is nearest to (clientX, clientY)?
  const hitTest = useCallback((clientX: number, clientY: number): FolioStar | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const point = { x: clientX - rect.left, y: clientY - rect.top };
    const geom = resolveGeometry();
    if (!geom) return null;

    let nearest: FolioStar | null = null;
    let nearestDistSq = STAR_HIT_RADIUS_PX * STAR_HIT_RADIUS_PX;
    for (const star of starsRef.current) {
      const pos = projectToScreen(
        star.celestial,
        cameraAzimuthRef.current,
        geom.centerX,
        geom.centerY,
        geom.radius,
      );
      const distSq = squaredDistance(pos, point);
      if (distSq < nearestDistSq) {
        nearest = star;
        nearestDistSq = distSq;
      }
    }
    return nearest;
  }, [resolveGeometry]);

  const clearSelectionNavigationTimeout = useCallback(() => {
    if (selectionNavigationTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(selectionNavigationTimeoutRef.current);
    selectionNavigationTimeoutRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearSelectionNavigationTimeout();
    },
    [clearSelectionNavigationTimeout],
  );

  const onSelectStar = useCallback(
    (star: FolioStar) => {
      clearSelectionNavigationTimeout();
      // Already selected → second click navigates to the folio.
      if (selectedIdRef.current === star.id) {
        router.push(`/oracle/${star.id}`);
        return;
      }
      setSelectedId(star.id);
      setPeerIds([]);
      selectionStartRef.current = performance.now();

      // After a beat for the user to take in the constellation, navigate.
      selectionNavigationTimeoutRef.current = window.setTimeout(() => {
        selectionNavigationTimeoutRef.current = null;
        if (selectedIdRef.current === star.id) {
          router.push(`/oracle/${star.id}`);
        }
      }, SELECTION_LINGER_MS);
    },
    [clearSelectionNavigationTimeout, router],
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
    };
    interactingRef.current = true;
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      // Horizontal motion rotates the sky around the zenith. One screen-width
      // of drag ≈ one full rotation. Feels right at most canvas sizes.
      const canvas = canvasRef.current;
      const w = canvas?.clientWidth ?? 600;
      const dx = e.clientX - drag.lastX;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      cameraAzimuthRef.current =
        (cameraAzimuthRef.current - (dx / w) * Math.PI * 2 + Math.PI * 4) % (Math.PI * 2);
      return;
    }
    const star = hitTest(e.clientX, e.clientY);
    setHoveredId(star?.id ?? null);
  }, [hitTest]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      dragRef.current = null;
      interactingRef.current = false;
      // Tap-vs-drag: total distance from the initial press, not from the last move.
      const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (moved < 4) {
        const star = hitTest(e.clientX, e.clientY);
        if (star) onSelectStar(star);
        else {
          // Tap on empty sky clears the constellation.
          clearSelectionNavigationTimeout();
          setSelectedId(null);
          setPeerIds([]);
          selectionStartRef.current = null;
        }
      }
    }
  }, [clearSelectionNavigationTimeout, hitTest, onSelectStar]);

  const onPointerLeave = useCallback(() => {
    setHoveredId(null);
    if (dragRef.current) {
      dragRef.current = null;
      interactingRef.current = false;
    }
  }, []);

  // Compose the corner label for the focused (hovered or selected) star.
  const focused = useMemo(() => {
    const id = hoveredId ?? selectedId;
    if (!id) return null;
    return stars.find((s) => s.id === id) ?? null;
  }, [hoveredId, selectedId, stars]);

  const empty = readings !== null && readings.length === 0;

  return (
    <div data-theme="oracle" className={styles.surface}>
      {selectedId !== null && (
        <AtlasConcordancePeerLoader
          key={selectedId}
          readingId={selectedId}
          onPeerIds={setPeerIds}
        />
      )}

      <div className={styles.headline} ref={headlineRef as React.RefObject<HTMLDivElement>}>
        <span className={styles.headlineTitle}>The Atlas</span>
        <span className={styles.headlineDash}>·</span>
        <span className={styles.headlineSub}>
          {readings === null
            ? "drawing the dome…"
            : empty
              ? "no stars yet"
              : `${readings.length} ${readings.length === 1 ? "star" : "stars"}`}
        </span>
      </div>

      {loadError !== null && (
        <FeedbackNotice feedback={loadError} className={styles.atlasFeedback} />
      )}

      {empty ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyLine}>
            No folios consulted yet. Ask the Oracle a question, and your sky
            will fill with stars.
          </p>
          <Link className={styles.emptyAction} href="/oracle">Consult the oracle →</Link>
        </div>
      ) : (
        <div ref={containerRef} className={styles.canvasFrame}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerLeave}
            onPointerLeave={onPointerLeave}
            aria-label="A celestial map of consulted oracle folios"
            role="img"
          />

          {/* The corner label fades up when a star is focused — Garamond italic,
              the marginalia voice. Roman numeral + motto + theme glyph. */}
          {focused && (
            <StarLabel focused={focused} selectedId={selectedId} peerIds={peerIds} />
          )}

          {/* Legend / instructions — present but quiet. */}
          <div className={styles.legend}>
            <span>Drag to turn the sky · click a star to trace its constellation</span>
          </div>

          {/* Accessibility: a screen-readable list of every star.
              Visually hidden; lets the page be navigated by keyboard. */}
          <ul className={styles.srStarList}>
            {stars.map((star) => (
              <li key={star.id}>
                <a href={`/oracle/${star.id}`}>
                  Folio {toRoman(star.folio_number)}
                  {star.folio_motto ? ` — ${star.folio_motto}` : ""}
                  {star.folio_theme ? ` (${star.folio_theme})` : ""}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link className={styles.backToAleph} href="/oracle">← Aleph</Link>
    </div>
  );
}

function AtlasConcordancePeerLoader({
  readingId,
  onPeerIds,
}: {
  readingId: string;
  onPeerIds: (peerIds: readonly string[]) => void;
}) {
  const concordanceResource = useApiResource<{ data: ConcordanceEntry[] }>({
    cacheKey: readingId,
    path: (id) => `/api/oracle/readings/${id}/concordance`,
  });

  useEffect(() => {
    if (concordanceResource.status === "ready") {
      onPeerIds(concordanceResource.data.data.map((entry) => entry.id));
      return;
    }
    if (concordanceResource.status === "error") {
      onPeerIds([]);
    }
  }, [concordanceResource, onPeerIds]);

  return null;
}
