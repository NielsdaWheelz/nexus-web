import {
  getDestination,
  type Destination,
  type DestinationId,
} from "@/lib/navigation/destinations";

export const SWITCHBOARD_PLACE_IDS = [
  "lectern",
  "libraries",
  "podcasts",
  "chats",
  "notes",
] as const satisfies readonly DestinationId[];

export const SWITCHBOARD_PLACES: readonly Destination[] =
  SWITCHBOARD_PLACE_IDS.map(getDestination);
