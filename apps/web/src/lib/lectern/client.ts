/**
 * Lectern + consumption HTTP transport facade.
 *
 * Wire types and strict decoders live in the transport-free `contract.ts` so
 * server resource composition and browser fetches share one isomorphic owner.
 */

import { apiFetch } from "@/lib/api/client";
import {
  decodeConsumptionResult,
  decodeDataEnvelope,
  decodeLecternResult,
  decodeLecternSnapshot,
  decodeRecentConsumptionEnvelope,
  RECENT_CONSUMPTION_MAX_ITEMS,
  type ConsumptionCommand,
  type ConsumptionResult,
  type LecternCommand,
  type LecternResult,
  type LecternSnapshot,
  type RecentConsumptionSnapshot,
} from "@/lib/lectern/contract";

export async function getLectern(signal?: AbortSignal): Promise<LecternSnapshot> {
  const body = await apiFetch<unknown>("/api/lectern", { signal });
  return decodeDataEnvelope(body, decodeLecternSnapshot, "GET /api/lectern");
}

export async function getRecentConsumption(
  limit: number,
  signal?: AbortSignal,
): Promise<RecentConsumptionSnapshot> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > RECENT_CONSUMPTION_MAX_ITEMS
  ) {
    throw new Error(`Invalid recent-consumption limit: ${limit}`);
  }
  const body = await apiFetch<unknown>(`/api/lectern/recent?limit=${limit}`, {
    signal,
  });
  return decodeRecentConsumptionEnvelope(body);
}

export async function postLecternCommand(
  command: LecternCommand,
  signal?: AbortSignal,
): Promise<LecternResult> {
  const body = await apiFetch<unknown>("/api/lectern/commands", {
    method: "POST",
    body: JSON.stringify(command),
    signal,
  });
  return decodeDataEnvelope(
    body,
    decodeLecternResult,
    "POST /api/lectern/commands",
  );
}

export async function postConsumptionCommand(
  command: ConsumptionCommand,
  signal?: AbortSignal,
): Promise<ConsumptionResult> {
  const body = await apiFetch<unknown>("/api/consumption/commands", {
    method: "POST",
    body: JSON.stringify(command),
    signal,
  });
  return decodeDataEnvelope(
    body,
    decodeConsumptionResult,
    "POST /api/consumption/commands",
  );
}
