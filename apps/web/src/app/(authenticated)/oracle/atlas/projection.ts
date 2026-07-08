/**
 * Pure math for The Atlas — a planispheric projection of Oracle folios
 * onto a celestial dome, in the spirit of a medieval astrolabe.
 *
 * Each folio is placed at a stable point on the hemisphere:
 *   - azimuth = hash(theme) mapped into [0, 2π) → same-theme folios cluster
 *               in the same arc of the sky, forming natural constellations.
 *   - altitude = hash(motto + folio_number) mapped into [zenithMargin, π/2 - rimMargin]
 *               → within a theme, folios spread across altitudes; the margins keep
 *               them off the rim (horizon) and the zenith point so labels can breathe.
 *
 * The projection itself is polar: zenithal distance becomes screen radius, and
 * azimuth (minus the camera's rotation) becomes the angle. This is the same
 * projection used on historical astrolabes — a true planisphere.
 *
 * Positions are deterministic: the same folio always lands in the same spot
 * across page loads. No DOM, no canvas — this module is unit-testable.
 */

export interface FolioStarInput {
  readonly id: string;
  readonly folio_number: number;
  readonly folio_motto: string | null;
  readonly folio_theme: string | null;
  readonly status: string;
}

export interface CelestialPosition {
  /** Azimuth around the dome, 0..2π. 0 is north (top), increasing clockwise. */
  readonly azimuth: number;
  /** Altitude above horizon, 0..π/2. 0 is at the rim, π/2 is at zenith. */
  readonly altitude: number;
}

export interface ScreenPosition {
  readonly x: number;
  readonly y: number;
  /** Radius from center, 0..radius. Useful for fade-by-radius effects. */
  readonly r: number;
  /** Angle on screen in radians, 0 = top, π/2 = right. */
  readonly theta: number;
}

export interface FolioStar extends FolioStarInput {
  readonly celestial: CelestialPosition;
}

/** Margin from the zenith point — stars never sit exactly at the center. */
const ZENITH_MARGIN = (Math.PI / 2) * 0.06;
/** Margin from the horizon rim — stars never sit on the very edge. */
const HORIZON_RIM_MARGIN = (Math.PI / 2) * 0.1;
/** Effective altitude span, [ZENITH_MARGIN, π/2 - HORIZON_RIM_MARGIN]. */
const ALTITUDE_SPAN = Math.PI / 2 - ZENITH_MARGIN - HORIZON_RIM_MARGIN;
/** Hash space normalizer — keeps the math in [0, 1). */
const HASH_NORMALIZER = 0xffffffff;

/**
 * 32-bit FNV-1a — fast, stable, no deps. Not cryptographic;
 * collision rate is fine for ~hundreds of folios.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiplication via shifts (avoids precision loss)
    hash =
      (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>>
      0;
  }
  return hash >>> 0;
}

function azimuthKey(folio: FolioStarInput): string {
  // Same theme → same arc of sky. Fall back to motto, then to folio id,
  // so themeless folios still land somewhere stable.
  const theme = folio.folio_theme?.trim();
  if (theme && theme.length > 0) return `theme::${theme.toLowerCase()}`;
  const motto = folio.folio_motto?.trim();
  if (motto && motto.length > 0) return `motto::${motto.toLowerCase()}`;
  return `folio::${folio.id}`;
}

function altitudeKey(folio: FolioStarInput): string {
  // Within a theme, scatter by motto + number so same-theme folios spread
  // across the altitude band rather than stacking.
  const motto = folio.folio_motto?.trim();
  return `${motto?.toLowerCase() ?? ""}::${folio.folio_number}`;
}

/**
 * Project one folio onto the celestial hemisphere. Deterministic given the
 * folio's theme, motto, and number.
 */
export function celestialPosition(folio: FolioStarInput): CelestialPosition {
  const az = (fnv1a(azimuthKey(folio)) / HASH_NORMALIZER) * Math.PI * 2;
  const alt =
    (fnv1a(altitudeKey(folio)) / HASH_NORMALIZER) * ALTITUDE_SPAN +
    HORIZON_RIM_MARGIN;
  return { azimuth: az, altitude: alt };
}

/**
 * Project a celestial position onto a 2D screen.
 *
 * The projection is polar (planispheric): zenithal distance (π/2 - altitude)
 * scales linearly to screen radius. The camera's azimuth subtracts from the
 * star's azimuth, so rotating the camera rotates the sky.
 *
 * Canvas convention: y grows down, so azimuth 0 (north) appears at top via
 * `y = centerY - r * cos(...)`.
 */
export function projectToScreen(
  celestial: CelestialPosition,
  cameraAzimuth: number,
  centerX: number,
  centerY: number,
  radius: number,
): ScreenPosition {
  const zenithDistance = Math.PI / 2 - celestial.altitude;
  const r = (zenithDistance / (Math.PI / 2)) * radius;
  const theta = celestial.azimuth - cameraAzimuth;
  const x = centerX + r * Math.sin(theta);
  const y = centerY - r * Math.cos(theta);
  return { x, y, r, theta };
}

/**
 * Attach a celestial position to each folio. Pure derivation, no I/O.
 */
export function placeFolios(folios: readonly FolioStarInput[]): readonly FolioStar[] {
  return folios.map((folio) => ({
    ...folio,
    celestial: celestialPosition(folio),
  }));
}

/**
 * Squared distance between two screen positions — used for hit-testing
 * the nearest star to a pointer.
 */
export function squaredDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Star magnitude (visual size + brightness factor) by folio status.
 * The completed folios shine; the pending ones glimmer; failures are
 * a memorial faintness rather than absence.
 */
export type StarMagnitude = "bright" | "glimmer" | "faint";

export function starMagnitude(status: string): StarMagnitude {
  if (status === "complete") return "bright";
  if (status === "failed") return "faint";
  return "glimmer"; // pending, streaming, or anything else in flight
}
