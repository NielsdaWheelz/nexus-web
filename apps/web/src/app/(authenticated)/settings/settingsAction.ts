import { ApiError } from "@/lib/api/client";

/**
 * A settings server action, with its two cross-cutting outcomes as the api's
 * errors: a request that never completed is E_NETWORK (fetch rejects with a
 * TypeError), an ended session the 401 the shell's latch turns into sign-in.
 */
export async function runSettingsAction<T>(
  action: () => Promise<T | "Ended">,
): Promise<Exclude<T, "Ended">> {
  let outcome: T | "Ended";
  try {
    outcome = await action();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ApiError(0, "E_NETWORK", "The settings request did not complete");
  }
  if (outcome === "Ended")
    throw new ApiError(401, "E_UNAUTHENTICATED", "The session ended");
  return outcome as Exclude<T, "Ended">;
}
