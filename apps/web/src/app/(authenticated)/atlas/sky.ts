/**
 * The atlas sky as pure geometry and canvas drawing. The dome is a planisphere:
 * a position (x, y) in the one global frame becomes polar coordinates about the
 * zenith, so the two ends of the principal axis face each other across the dome
 * rather than meeting on one meridian. Unpositioned media (the nebula) sit on the
 * rim; folios are placed by a hash of their theme, so a theme keeps one arc.
 */
import type { Schema } from "@/lib/api/wire";
import type { OracleReadingSummary } from "@/lib/oracle/oracle";

/** angle: radians clockwise from north; radial: 0 at the zenith, 1 at the rim. */
export interface DomePoint {
  readonly angle: number;
  readonly radial: number;
}

export type Magnitude = "bright" | "glimmer" | "faint";

export interface Star {
  readonly layer: "corpus" | "readings";
  readonly id: string;
  readonly at: DomePoint;
  readonly magnitude: Magnitude;
  readonly nebula: boolean;
  readonly corpus?: Schema<"StarOut">;
  readonly folio?: OracleReadingSummary;
}

const NEBULA_RADIAL = 0.96;

/** 32-bit FNV-1a: stable, fast, not cryptographic. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const unit = (key: string) => fnv1a(key) / 0x100000000;

export function corpusStar(star: Schema<"StarOut">): Star {
  const magnitude =
    star.magnitude >= 5 ? "bright" : star.magnitude >= 1 ? "glimmer" : "faint";
  const placed = star.x !== null && star.y !== null;
  const dx = (star.x ?? 0.5) - 0.5;
  const dy = 0.5 - (star.y ?? 0.5);
  return {
    layer: "corpus",
    id: star.media_id,
    corpus: star,
    magnitude: placed ? magnitude : "faint",
    nebula: !placed,
    at: placed
      ? {
          angle: Math.atan2(dx, dy),
          radial: 0.06 + 0.84 * Math.SQRT2 * Math.hypot(dx, dy),
        }
      : { angle: unit(star.media_id) * 2 * Math.PI, radial: NEBULA_RADIAL },
  };
}

export function folioStar(folio: OracleReadingSummary): Star {
  const theme = folio.folio_theme ?? folio.folio_motto ?? folio.id;
  return {
    layer: "readings",
    id: folio.id,
    folio,
    nebula: false,
    magnitude:
      folio.status === "complete"
        ? "bright"
        : folio.status === "failed"
          ? "faint"
          : "glimmer",
    at: {
      angle: unit(`theme::${theme.toLowerCase()}`) * 2 * Math.PI,
      radial:
        0.1 + 0.8 * unit(`${folio.folio_motto ?? ""}::${folio.folio_number}`),
    },
  };
}

export interface Screen {
  readonly w: number;
  readonly h: number;
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly camera: number;
}

/** Size the canvas backing store to its frame at the device pixel ratio. */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  frame: HTMLElement,
  camera: number,
): Screen {
  const rect = frame.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(320, Math.floor(rect.width));
  const h = Math.max(320, Math.floor(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return {
    w,
    h,
    cx: w / 2,
    cy: h / 2,
    radius: Math.min(w, h) / 2 - 24,
    camera,
  };
}

export function toScreen(at: DomePoint, s: Screen): { x: number; y: number } {
  const theta = at.angle - s.camera;
  const r = at.radial * s.radius;
  return { x: s.cx + r * Math.sin(theta), y: s.cy - r * Math.cos(theta) };
}

/** Prim's tree over a constellation's positioned members, as id pairs. */
export function spanningTree(
  members: readonly string[],
  at: Map<string, DomePoint>,
) {
  const plane = (p: DomePoint): [number, number] => [
    p.radial * Math.sin(p.angle),
    p.radial * Math.cos(p.angle),
  ];
  const nodes = members.filter((id) => at.has(id));
  const joined = new Set(nodes.slice(0, 1));
  const pairs: [string, string][] = [];
  while (joined.size < nodes.length) {
    let best: [string, string, number] | null = null;
    for (const from of joined) {
      const [ax, ay] = plane(at.get(from)!);
      for (const to of nodes) {
        if (joined.has(to)) continue;
        const [bx, by] = plane(at.get(to)!);
        const weight = (ax - bx) ** 2 + (ay - by) ** 2;
        if (best === null || weight < best[2]) best = [from, to, weight];
      }
    }
    joined.add(best![1]);
    pairs.push([best![0], best![1]]);
  }
  return pairs;
}

const STYLE: Record<
  Magnitude,
  { core: number; glow: number; alpha: number; rgb: string }
> = {
  bright: { core: 2.4, glow: 13, alpha: 0.55, rgb: "243, 233, 208" }, // --oracle-cream
  glimmer: { core: 1.6, glow: 9, alpha: 0.3, rgb: "195, 154, 77" }, // --oracle-gold
  faint: { core: 1.2, glow: 6, alpha: 0.15, rgb: "107, 42, 42" }, // --oracle-maroon
};
const CORE_ALPHA: Record<Magnitude, number> = {
  bright: 1,
  glimmer: 0.75,
  faint: 0.35,
};
const EDGE_RGB = { context: "195, 154, 77", contradicts: "138, 82, 54" };

export interface Scene {
  readonly stars: readonly Star[];
  readonly edges: readonly Schema<"AtlasEdgeOut">[];
  readonly constellations: readonly Schema<"ConstellationOut">[];
  readonly tree: readonly [string, string][];
  readonly hovered: string | null;
  readonly selected: string | null;
  readonly peers: readonly string[];
}

/** One frame; time in seconds animates the twinkle, 0 keeps the sky still. */
export function drawSky(
  ctx: CanvasRenderingContext2D,
  s: Screen,
  scene: Scene,
  time: number,
) {
  const { w, h, cx, cy, radius } = s;
  ctx.clearRect(0, 0, w, h);
  const wash = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  wash.addColorStop(0, "rgba(38, 30, 24, 0.55)");
  wash.addColorStop(0.7, "rgba(20, 17, 15, 0)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);
  for (const fraction of [1 / 3, 2 / 3, 1]) {
    ctx.strokeStyle = `rgba(74, 59, 42, ${fraction === 1 ? 1 : 0.5})`;
    ctx.lineWidth = fraction === 1 ? 1.25 : 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * fraction, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(142, 120, 72, 0.85)";
  ctx.font = "11px serif";
  const north = toScreen({ angle: 0, radial: (radius + 14) / radius }, s);
  ctx.fillText("✦", north.x, north.y);

  const at = new Map(
    scene.stars
      .filter((star) => !star.nebula)
      .map((star) => [star.id, star.at]),
  );
  const line = (a: DomePoint, b: DomePoint) => {
    const from = toScreen(a, s);
    const to = toScreen(b, s);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "rgba(142, 120, 72, 0.28)";
  for (const [a, b] of scene.tree) line(at.get(a)!, at.get(b)!);
  for (const edge of scene.edges) {
    const a = at.get(edge.source_media_id);
    const b = at.get(edge.target_media_id);
    if (!a || !b) continue;
    const contradicts = edge.kind === "contradicts";
    ctx.strokeStyle = `rgba(${EDGE_RGB[edge.kind]}, ${contradicts ? 0.6 : 0.1})`;
    ctx.lineWidth = contradicts ? 0.9 : 0.6;
    line(a, b);
  }
  const selected = scene.selected === null ? undefined : at.get(scene.selected);
  if (selected) {
    ctx.strokeStyle = "rgba(195, 154, 77, 0.55)";
    ctx.setLineDash([2, 4]);
    for (const peer of scene.peers)
      if (at.has(peer)) line(selected, at.get(peer)!);
    ctx.setLineDash([]);
  }

  ctx.font = "italic small-caps 10px 'IM Fell English', serif";
  ctx.fillStyle = "rgba(142, 120, 72, 0.75)";
  for (const constellation of scene.constellations) {
    const points = constellation.member_media_ids.flatMap((id) =>
      at.has(id) ? [toScreen(at.get(id)!, s)] : [],
    );
    if (points.length === 0) continue;
    const x = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    ctx.fillText(constellation.name, x, y - 12);
  }

  // Nebula stars last, so the rim never hides a placed star.
  const ordered = [...scene.stars].sort(
    (a, b) => Number(a.nebula) - Number(b.nebula),
  );
  for (const star of ordered) {
    const style = STYLE[star.magnitude];
    const pos = toScreen(star.at, s);
    const twinkle = 0.85 + 0.15 * Math.sin(fnv1a(star.id) * 0.37 + time * 0.5);
    const focus = star.id === scene.hovered ? 1.3 : 1;
    const glowRadius =
      style.glow *
      (star.layer === "readings" ? 1.5 : star.nebula ? 0.7 : 1) *
      focus;
    const glow = ctx.createRadialGradient(
      pos.x,
      pos.y,
      0,
      pos.x,
      pos.y,
      glowRadius,
    );
    glow.addColorStop(
      0,
      `rgba(${style.rgb}, ${style.alpha * twinkle * focus})`,
    );
    glow.addColorStop(1, `rgba(${style.rgb}, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, glowRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${style.rgb}, ${CORE_ALPHA[star.magnitude] * twinkle})`;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, style.core * focus, 0, Math.PI * 2);
    ctx.fill();
  }
  if (scene.stars.some((star) => star.nebula)) {
    const label = toScreen({ angle: Math.PI * 1.5, radial: NEBULA_RADIAL }, s);
    ctx.font = "italic 10px 'IM Fell English', serif";
    ctx.fillStyle = "rgba(107, 42, 42, 0.7)";
    ctx.fillText("Nebula", label.x, label.y);
  }
}
