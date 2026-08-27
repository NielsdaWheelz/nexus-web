import {
  expectArray,
  expectCanonicalUuid,
  expectExactRecord,
  expectIsoInstant,
  expectNonnegativeInteger,
  expectNullableString,
  expectOneOf,
} from "@/lib/validation";

export const WAYPOINT_VOICE_STATUSES = [
  "idle",
  "recording",
  "transcribing",
  "done",
  "failed",
] as const;

export type WaypointVoiceStatus = (typeof WAYPOINT_VOICE_STATUSES)[number];

export interface WalknoteWaypoint {
  id: string;
  media_id: string;
  position_ms: number;
  recorded_at: string;
  voice_text: string | null;
  voice_status: WaypointVoiceStatus;
}

function decodeWalknoteWaypoint(
  raw: unknown,
  index: number,
): WalknoteWaypoint {
  const name = `Walknote session[${index}]`;
  const waypoint = expectExactRecord(
    raw,
    [
      "id",
      "media_id",
      "position_ms",
      "recorded_at",
      "voice_text",
      "voice_status",
    ],
    name,
  );
  return {
    id: expectCanonicalUuid(waypoint.id, `${name}.id`),
    media_id: expectCanonicalUuid(waypoint.media_id, `${name}.media_id`),
    position_ms: expectNonnegativeInteger(
      waypoint.position_ms,
      `${name}.position_ms`,
    ),
    recorded_at: expectIsoInstant(waypoint.recorded_at, `${name}.recorded_at`),
    voice_text: expectNullableString(waypoint.voice_text, `${name}.voice_text`),
    voice_status: expectOneOf(
      waypoint.voice_status,
      WAYPOINT_VOICE_STATUSES,
      `${name}.voice_status`,
    ),
  };
}

export function decodeWalknoteSession(raw: unknown): WalknoteWaypoint[] {
  const waypoints = expectArray(
    raw,
    decodeWalknoteWaypoint,
    "Walknote session",
  );
  const ids = new Set(waypoints.map(({ id }) => id));
  if (ids.size !== waypoints.length) {
    throw new TypeError("Walknote session waypoint ids must be unique");
  }
  return waypoints;
}
