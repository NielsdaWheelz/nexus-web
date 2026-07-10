"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackNotice, toFeedback } from "@/components/feedback/Feedback";
import { useResource } from "@/lib/api/useResource";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { constellationMst } from "@/lib/atlas/constellationMst";
import { corpusMagnitude } from "@/lib/atlas/corpusMagnitude";
import OracleThemeWrapper from "@/app/(authenticated)/oracle/OracleThemeWrapper";
import styles from "./atlas.module.css";
import AtlasConcordancePeerLoader from "./AtlasConcordancePeerLoader";
import {
  ALTITUDE_SPAN,
  HORIZON_RIM_MARGIN,
  ZENITH_MARGIN,
  celestialPosition,
  fnv1a,
  projectToScreen,
  squaredDistance,
  starMagnitude,
  type CelestialPosition,
  type FolioStar,
  type FolioStarInput,
  type StarMagnitude,
} from "./projection";

// ---- API read model --------------------------------------------------------

interface StarOut {
  media_id: string;
  x: number | null;
  y: number | null;
  title: string;
  kind: string;
  magnitude: number;
}

interface ConstellationOut {
  library_id: string;
  name: string;
  member_media_ids: string[];
}

interface AtlasEdgeOut {
  source_media_id: string;
  target_media_id: string;
  kind: "context" | "contradicts";
  origin: string;
}

interface AtlasOut {
  stars: StarOut[];
  constellations: ConstellationOut[];
  edges: AtlasEdgeOut[];
}

// ---- geometry constants (reused from the oracle atlas) ---------------------

const IDLE_ROTATION_RAD_PER_SEC = (0.5 * Math.PI) / 180;
const STAR_HIT_RADIUS_PX = 22;
const HASH_NORMALIZER = 0xffffffff;
/** Readings stars glow 1.5× brighter so they stand apart from corpus stars. */
const READINGS_GLOW_BOOST = 1.5;

interface StarStyle {
  readonly core: number;
  readonly glow: number;
  readonly coreAlpha: number;
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

// ---- unified hittable stars ------------------------------------------------

interface CorpusStar {
  readonly layer: "corpus";
  readonly id: string; // media_id
  readonly title: string;
  readonly mediaKind: string;
  readonly magnitude: number;
  readonly isNebula: boolean;
  readonly celestial: CelestialPosition;
}

interface ReadingStar {
  readonly layer: "readings";
  readonly id: string; // folio id
  readonly folio: FolioStar;
  readonly celestial: CelestialPosition;
}

type HitStar = CorpusStar | ReadingStar;

/** Corpus (x,y)∈[0,1] → celestial (§4.2). Nebula (x==null) → stable rim arc. */
function corpusCelestial(star: StarOut): { celestial: CelestialPosition; isNebula: boolean } {
  if (star.x !== null && star.y !== null) {
    return {
      celestial: {
        azimuth: star.x * Math.PI * 2,
        altitude: ZENITH_MARGIN + star.y * ALTITUDE_SPAN,
      },
      isNebula: false,
    };
  }
  const hash = fnv1a(star.media_id.replace(/-/g, ""));
  return {
    celestial: {
      azimuth: (hash / HASH_NORMALIZER) * Math.PI * 2,
      altitude: HORIZON_RIM_MARGIN * 0.4,
    },
    isNebula: true,
  };
}

// ---- drawing ---------------------------------------------------------------

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

interface EdgeColors {
  readonly synapse: string;
  readonly contradicts: string;
}

function drawDome(d: DrawContext): void {
  const { ctx, w, h, centerX, centerY, radius } = d;
  ctx.clearRect(0, 0, w, h);
  const wash = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
  wash.addColorStop(0, "rgba(38, 30, 24, 0.55)");
  wash.addColorStop(0.7, "rgba(20, 17, 15, 0)");
  wash.addColorStop(1, "rgba(20, 17, 15, 0)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(74, 59, 42, 0.5)";
  ctx.lineWidth = 1;
  for (const frac of [1 / 3, 2 / 3]) {
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(74, 59, 42, 1)";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(195, 154, 77, 0.35)";
  ctx.beginPath();
  ctx.arc(centerX, centerY, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawCardinal(d: DrawContext): void {
  const { ctx, centerX, centerY, radius, cameraAzimuth } = d;
  const theta = -cameraAzimuth;
  const x = centerX + (radius + 14) * Math.sin(theta);
  const y = centerY - (radius + 14) * Math.cos(theta);
  ctx.fillStyle = "rgba(142, 120, 72, 0.85)";
  ctx.font = "11px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("✦", x, y);
}

function drawStar(
  d: DrawContext,
  celestial: CelestialPosition,
  mag: StarMagnitude,
  glowBoost: number,
  twinkleSeed: number,
  isHover: boolean,
): void {
  const { ctx, centerX, centerY, radius, cameraAzimuth, time } = d;
  const pos = projectToScreen(celestial, cameraAzimuth, centerX, centerY, radius);
  const style = styleForMagnitude(mag);
  const color = starColor(mag);
  const phase = (twinkleSeed * 0.37 + time * 0.5) % (Math.PI * 2);
  const twinkle = 0.85 + 0.15 * Math.sin(phase);
  const focusBoost = isHover ? 1.3 : 1.0;

  const glowRadius = style.glow * glowBoost * focusBoost;
  const glow = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, glowRadius);
  glow.addColorStop(0, `rgba(${color}, ${style.glowAlpha * twinkle * focusBoost})`);
  glow.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, glowRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = `rgba(${color}, ${style.coreAlpha * twinkle})`;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, style.core * focusBoost, 0, Math.PI * 2);
  ctx.fill();
}

function drawConstellationMst(
  d: DrawContext,
  pairs: readonly [string, string][],
  posMap: Map<string, CelestialPosition>,
): void {
  const { ctx, centerX, centerY, radius, cameraAzimuth } = d;
  ctx.strokeStyle = "rgba(142, 120, 72, 0.28)";
  ctx.lineWidth = 0.6;
  for (const [a, b] of pairs) {
    const pa = posMap.get(a);
    const pb = posMap.get(b);
    if (!pa || !pb) continue;
    const from = projectToScreen(pa, cameraAzimuth, centerX, centerY, radius);
    const to = projectToScreen(pb, cameraAzimuth, centerX, centerY, radius);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
}

function drawEdges(
  d: DrawContext,
  edges: readonly AtlasEdgeOut[],
  posMap: Map<string, CelestialPosition>,
  colors: EdgeColors,
): void {
  const { ctx, centerX, centerY, radius, cameraAzimuth } = d;
  for (const edge of edges) {
    const source = posMap.get(edge.source_media_id);
    const target = posMap.get(edge.target_media_id);
    if (!source || !target) continue;
    const from = projectToScreen(source, cameraAzimuth, centerX, centerY, radius);
    const to = projectToScreen(target, cameraAzimuth, centerX, centerY, radius);
    if (edge.kind === "contradicts") {
      ctx.strokeStyle = colors.contradicts;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 0.9;
    } else {
      ctx.strokeStyle = colors.synapse;
      ctx.globalAlpha = 0.1;
      ctx.lineWidth = 0.6;
    }
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawConstellationLabels(
  d: DrawContext,
  constellations: readonly ConstellationOut[],
  posMap: Map<string, CelestialPosition>,
): void {
  const { ctx, centerX, centerY, radius, cameraAzimuth } = d;
  // CSS vars are unparseable in canvas fonts (same caveat as drawCardinal).
  ctx.font = "italic small-caps 10px 'IM Fell English', serif";
  ctx.fillStyle = "rgba(142, 120, 72, 0.75)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const constellation of constellations) {
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (const memberId of constellation.member_media_ids) {
      const celestial = posMap.get(memberId);
      if (!celestial) continue;
      const pos = projectToScreen(celestial, cameraAzimuth, centerX, centerY, radius);
      sx += pos.x;
      sy += pos.y;
      count += 1;
    }
    if (count === 0) continue;
    ctx.fillText(constellation.name, sx / count, sy / count - 12);
  }
}

function drawReadingsConstellation(
  d: DrawContext,
  readingStars: readonly ReadingStar[],
  selectedId: string | null,
  peerIds: readonly string[],
): void {
  if (!selectedId || peerIds.length === 0) return;
  const selected = readingStars.find((star) => star.id === selectedId);
  if (!selected) return;
  const { ctx, centerX, centerY, radius, cameraAzimuth } = d;
  const start = projectToScreen(selected.celestial, cameraAzimuth, centerX, centerY, radius);
  ctx.strokeStyle = "rgba(195, 154, 77, 0.55)";
  ctx.lineWidth = 0.75;
  ctx.setLineDash([2, 4]);
  for (const peerId of peerIds) {
    const peer = readingStars.find((star) => star.id === peerId);
    if (!peer) continue;
    const end = projectToScreen(peer.celestial, cameraAzimuth, centerX, centerY, radius);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawNebulaLabel(d: DrawContext): void {
  const { ctx, centerX, centerY, radius, cameraAzimuth } = d;
  const celestial: CelestialPosition = {
    azimuth: Math.PI * 1.5,
    altitude: HORIZON_RIM_MARGIN * 0.4,
  };
  const pos = projectToScreen(celestial, cameraAzimuth, centerX, centerY, radius);
  ctx.font = "italic 10px 'IM Fell English', serif";
  ctx.fillStyle = "rgba(107, 42, 42, 0.7)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Nebula", pos.x, pos.y);
}

// ---- component -------------------------------------------------------------

export default function GrandAtlasPaneBody() {
  const paneRouter = usePaneRouter();
  const searchParams = usePaneSearchParams();
  const readingsHighlighted = searchParams.get("layer") === "readings";

  const [layers, setLayers] = useState({ corpus: true, readings: readingsHighlighted });
  const [hovered, setHovered] = useState<HitStar | null>(null);
  const [selectedReadingId, setSelectedReadingId] = useState<string | null>(null);
  const [peerIds, setPeerIds] = useState<readonly string[]>([]);

  const atlasResource = useResource<{ data: AtlasOut }>({
    cacheKey: "atlas",
    path: () => "/api/atlas",
  });
  const atlas = atlasResource.status === "ready" ? atlasResource.data.data : null;
  const loadError =
    atlasResource.status === "error"
      ? toFeedback(atlasResource.error, { fallback: "The Atlas could not be loaded." })
      : null;

  // Readings layer is fetched lazily — a null cacheKey holds the fetch until the
  // layer is switched on.
  const readingsResource = useResource<{ data: FolioStarInput[] }>({
    cacheKey: layers.readings ? "oracle-readings" : null,
    path: () => "/api/oracle/readings",
  });
  const readings = readingsResource.status === "ready" ? readingsResource.data.data : null;

  const corpusStars = useMemo<CorpusStar[]>(() => {
    if (!atlas) return [];
    return atlas.stars.map((star) => {
      const { celestial, isNebula } = corpusCelestial(star);
      return {
        layer: "corpus",
        id: star.media_id,
        title: star.title,
        mediaKind: star.kind,
        magnitude: star.magnitude,
        isNebula,
        celestial,
      };
    });
  }, [atlas]);

  const readingStars = useMemo<ReadingStar[]>(() => {
    if (!readings) return [];
    return readings.map((folio) => {
      const celestial = celestialPosition(folio);
      return { layer: "readings", id: folio.id, folio: { ...folio, celestial }, celestial };
    });
  }, [readings]);

  const hasNebula = useMemo(() => corpusStars.some((star) => star.isNebula), [corpusStars]);

  // Non-Nebula corpus positions drive MST + edge + label routing.
  const corpusPosMap = useMemo(() => {
    const map = new Map<string, CelestialPosition>();
    for (const star of corpusStars) {
      if (!star.isNebula) map.set(star.id, star.celestial);
    }
    return map;
  }, [corpusStars]);

  const mstPairs = useMemo<[string, string][]>(() => {
    if (!atlas) return [];
    const pairs: [string, string][] = [];
    for (const constellation of atlas.constellations) {
      pairs.push(
        ...constellationMst({
          celestialPositions: corpusPosMap,
          memberMediaIds: constellation.member_media_ids,
        }),
      );
    }
    return pairs;
  }, [atlas, corpusPosMap]);

  // Refs for the RAF loop (avoids re-subscribing the loop on every state change).
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cameraAzimuthRef = useRef(0);
  const interactingRef = useRef(false);
  const reducedMotionRef = useRef(false);
  const edgeColorsRef = useRef<EdgeColors>({
    synapse: "#c39a4d",
    contradicts: "#8a5236",
  });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
  } | null>(null);
  const lastFrameRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const layersRef = useRef(layers);
  layersRef.current = layers;
  const corpusStarsRef = useRef(corpusStars);
  corpusStarsRef.current = corpusStars;
  const readingStarsRef = useRef(readingStars);
  readingStarsRef.current = readingStars;
  const mstPairsRef = useRef(mstPairs);
  mstPairsRef.current = mstPairs;
  const corpusPosMapRef = useRef(corpusPosMap);
  corpusPosMapRef.current = corpusPosMap;
  const atlasRef = useRef(atlas);
  atlasRef.current = atlas;
  const hasNebulaRef = useRef(hasNebula);
  hasNebulaRef.current = hasNebula;
  const hoveredIdRef = useRef<string | null>(null);
  hoveredIdRef.current = hovered?.id ?? null;
  const selectedReadingIdRef = useRef(selectedReadingId);
  selectedReadingIdRef.current = selectedReadingId;
  const peerIdsRef = useRef(peerIds);
  peerIdsRef.current = peerIds;

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => resolveGeometry());
    observer.observe(container);
    return () => observer.disconnect();
  }, [resolveGeometry]);

  // Resolve the scoped edge tokens to concrete rgb() once at mount. Canvas
  // cannot use var() directly, and getComputedStyle on a custom property returns
  // its unresolved declared value (which still contains var()), so a throwaway
  // probe span resolves the whole chain (incl. color-mix) to an rgb string.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resolve = (token: string, fallback: string): string => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token}, ${fallback})`;
      probe.style.display = "none";
      container.appendChild(probe);
      const color = getComputedStyle(probe).color || fallback;
      container.removeChild(probe);
      return color;
    };
    edgeColorsRef.current = {
      synapse: resolve("--atlas-synapse-line", "#c39a4d"),
      contradicts: resolve("--atlas-contradicts-line", "#8a5236"),
    };
  }, []);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      reducedMotionRef.current = mql.matches;
    };
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);

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
        const time = reducedMotionRef.current ? 0 : now / 1000;
        const d: DrawContext = { ctx, ...geom, cameraAzimuth: cameraAzimuthRef.current, time };
        drawDome(d);
        drawCardinal(d);

        const showCorpus = layersRef.current.corpus;
        const showReadings = layersRef.current.readings;

        if (showCorpus && atlasRef.current) {
          drawConstellationMst(d, mstPairsRef.current, corpusPosMapRef.current);
          drawEdges(d, atlasRef.current.edges, corpusPosMapRef.current, edgeColorsRef.current);
          drawConstellationLabels(d, atlasRef.current.constellations, corpusPosMapRef.current);
          // Corpus stars first; Nebula stars drawn last below so they don't occlude.
          for (const star of corpusStarsRef.current) {
            if (star.isNebula) continue;
            drawStar(
              d,
              star.celestial,
              corpusMagnitude(star.magnitude),
              1,
              fnv1a(star.id),
              star.id === hoveredIdRef.current,
            );
          }
        }

        if (showReadings) {
          drawReadingsConstellation(
            d,
            readingStarsRef.current,
            selectedReadingIdRef.current,
            peerIdsRef.current,
          );
          for (const star of readingStarsRef.current) {
            drawStar(
              d,
              star.celestial,
              starMagnitude(star.folio.status),
              READINGS_GLOW_BOOST,
              star.folio.folio_number,
              star.id === hoveredIdRef.current,
            );
          }
        }

        if (showCorpus && atlasRef.current) {
          for (const star of corpusStarsRef.current) {
            if (!star.isNebula) continue;
            drawStar(d, star.celestial, "faint", 0.7, fnv1a(star.id), star.id === hoveredIdRef.current);
          }
          if (hasNebulaRef.current) drawNebulaLabel(d);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastFrameRef.current = 0;
    };
  }, [resolveGeometry]);

  const hitTest = useCallback(
    (clientX: number, clientY: number): HitStar | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const point = { x: clientX - rect.left, y: clientY - rect.top };
      const geom = resolveGeometry();
      if (!geom) return null;
      const candidates: HitStar[] = [];
      if (layersRef.current.corpus) candidates.push(...corpusStarsRef.current);
      if (layersRef.current.readings) candidates.push(...readingStarsRef.current);
      let nearest: HitStar | null = null;
      let nearestDistSq = STAR_HIT_RADIUS_PX * STAR_HIT_RADIUS_PX;
      for (const star of candidates) {
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
    },
    [resolveGeometry],
  );

  const onSelectStar = useCallback(
    (star: HitStar) => {
      if (star.layer === "corpus") {
        requestOpenInAppPane(`/media/${star.id}`);
        return;
      }
      // Readings folio: first tap traces its constellation, second enters. Read
      // the current selection from the ref so back-to-back taps aren't served a
      // stale closure.
      if (selectedReadingIdRef.current === star.id) {
        paneRouter.push(`/oracle/${star.id}`);
        return;
      }
      // Update the ref synchronously so a second tap in the same tick (before
      // React re-renders) reads the fresh selection.
      selectedReadingIdRef.current = star.id;
      setSelectedReadingId(star.id);
      setPeerIds([]);
    },
    [paneRouter],
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
    };
    interactingRef.current = true;
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (drag && drag.pointerId === e.pointerId) {
        const canvas = canvasRef.current;
        const w = canvas?.clientWidth ?? 600;
        const dx = e.clientX - drag.lastX;
        drag.lastX = e.clientX;
        cameraAzimuthRef.current =
          (cameraAzimuthRef.current - (dx / w) * Math.PI * 2 + Math.PI * 4) % (Math.PI * 2);
        return;
      }
      setHovered(hitTest(e.clientX, e.clientY));
    },
    [hitTest],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (drag && drag.pointerId === e.pointerId) {
        dragRef.current = null;
        interactingRef.current = false;
        const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
        if (moved < 4) {
          const star = hitTest(e.clientX, e.clientY);
          if (star) onSelectStar(star);
          else {
            setSelectedReadingId(null);
            setPeerIds([]);
          }
        }
      }
    },
    [hitTest, onSelectStar],
  );

  const onPointerLeave = useCallback(() => {
    setHovered(null);
    if (dragRef.current) {
      dragRef.current = null;
      interactingRef.current = false;
    }
  }, []);

  const toggleLayer = useCallback((layer: "corpus" | "readings") => {
    setLayers((prev) => ({ ...prev, [layer]: !prev[layer] }));
  }, []);

  const starCount = corpusStars.length;
  const loading = atlas === null && loadError === null;

  return (
    <OracleThemeWrapper>
      <div className={styles.surface}>
        {selectedReadingId !== null && layers.readings && (
          <AtlasConcordancePeerLoader
            key={selectedReadingId}
            readingId={selectedReadingId}
            onPeerIds={setPeerIds}
          />
        )}

        <div className={styles.headline}>
          <span className={styles.headlineTitle}>The Atlas</span>
          <span className={styles.headlineDash}>·</span>
          <span className={styles.headlineSub}>
            {loading ? "charting the corpus…" : `${starCount} ${starCount === 1 ? "star" : "stars"}`}
          </span>
        </div>

        {loadError !== null && (
          <FeedbackNotice feedback={loadError} className={styles.atlasFeedback} />
        )}

        <div ref={containerRef} className={styles.canvasFrame}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerLeave}
            onPointerLeave={onPointerLeave}
            aria-label="A celestial chart of the whole library"
            role="img"
          />

          {hovered && (
            <div className={styles.starLabel} aria-live="polite">
              {hovered.layer === "corpus" ? (
                <>
                  <span className={styles.starLabelMotto}>{hovered.title}</span>
                  <span className={styles.corpusLabelKind}>
                    {hovered.mediaKind} · {hovered.magnitude}{" "}
                    {hovered.magnitude === 1 ? "highlight" : "highlights"}
                  </span>
                </>
              ) : (
                <>
                  <span className={styles.starLabelFolio}>Folio {hovered.folio.folio_number}</span>
                  {hovered.folio.folio_motto && (
                    <span className={styles.starLabelMotto}>{hovered.folio.folio_motto}</span>
                  )}
                  {selectedReadingId === hovered.id && (
                    <span className={styles.starLabelHint}>
                      {peerIds.length > 0
                        ? `Constellation of ${peerIds.length} · click again to enter`
                        : "click again to enter"}
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          <div className={styles.layerToggles}>
            <button
              type="button"
              className={styles.layerToggle}
              aria-pressed={layers.corpus}
              onClick={() => toggleLayer("corpus")}
            >
              Corpus
            </button>
            <button
              type="button"
              className={styles.layerToggle}
              aria-pressed={layers.readings}
              onClick={() => toggleLayer("readings")}
            >
              Readings
            </button>
          </div>

          <div className={styles.legend}>
            <span>Drag to turn the sky · click a star to open the work</span>
          </div>

          <ul className={styles.srStarList}>
            {corpusStars.map((star) => (
              <li key={star.id}>
                <a href={`/media/${star.id}`}>
                  {star.title} ({star.mediaKind})
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </OracleThemeWrapper>
  );
}
