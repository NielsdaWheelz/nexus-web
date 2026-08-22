import { describe, expect, it } from "vitest";
import {
  barrierAcknowledged,
  barrierChanged,
  barrierRejected,
  connectionFailed,
  createNativeOperationPump,
  dispatch,
  reconnected,
  release,
  retry,
  settled,
  stampOperation,
  visibleConnectionFailure,
  type DispatchedNativeOperation,
  type NativeOperation,
  type NativeOperationKey,
  type NativeOperationPump,
  type PumpStep,
} from "./nativeOperationPump";

// Risk: the player pump silently stalls (lost Retry, intent parked on a dead
// receipt, queue blocked behind a stale intent) or replays an intent twice.

const UNAVAILABLE = {
  code: "NativePlayerUnavailable",
  message: "The Android player is unavailable. Please retry.",
};

function operation(
  key: NativeOperationKey,
  name: string,
  stillApplies = () => true,
): NativeOperation & { name: string } {
  return { key, name, run: () => Promise.resolve(), stillApplies };
}

function ran(step: PumpStep): string[] {
  return step.effects.map((effect) => (effect.operation as { name?: string }).name ?? "?");
}

function only(step: PumpStep): DispatchedNativeOperation {
  expect(step.effects).toHaveLength(1);
  return step.effects[0].operation;
}

function pumpAfter(...steps: ((pump: NativeOperationPump) => PumpStep)[]): {
  pump: NativeOperationPump;
  log: string[];
} {
  let pump = createNativeOperationPump();
  const log: string[] = [];
  for (const step of steps) {
    const next = step(pump);
    log.push(...ran(next));
    pump = next.pump;
  }
  return { pump, log };
}

describe("native operation pump: session intents", () => {
  it("runs one session intent at a time and drains the FIFO queue as each settles", () => {
    const first = dispatch(createNativeOperationPump(), operation("SessionIntent", "play"));
    const running = only(first);
    const queued = dispatch(first.pump, operation("SessionIntent", "seek"));
    expect(queued.effects).toEqual([]);
    const queuedAgain = dispatch(queued.pump, operation("SessionIntent", "pause"));
    expect(queuedAgain.effects).toEqual([]);

    const afterPlay = settled(queuedAgain.pump, running);
    expect(ran(afterPlay)).toEqual(["seek"]);
    const afterSeek = settled(afterPlay.pump, only(afterPlay));
    expect(ran(afterSeek)).toEqual(["pause"]);
    expect(settled(afterSeek.pump, only(afterSeek)).pump.inFlight).toBeNull();
  });

  it("discards a queued intent that no longer applies without blocking the next one", () => {
    const first = dispatch(createNativeOperationPump(), operation("SessionIntent", "play"));
    const queued = dispatch(
      first.pump,
      operation("SessionIntent", "stale-seek", () => false),
    );
    const live = dispatch(queued.pump, operation("SessionIntent", "pause"));

    const drained = settled(live.pump, only(first));

    expect(ran(drained)).toEqual(["pause"]);
  });

  it("releases a cancelled intent and runs what was queued behind it", () => {
    const first = dispatch(createNativeOperationPump(), operation("SessionIntent", "play"));
    const queued = dispatch(first.pump, operation("SessionIntent", "seek"));

    const released = release(queued.pump, only(first));

    expect(ran(released)).toEqual(["seek"]);
  });
});

describe("native operation pump: transport failure is derived state", () => {
  it("keeps a frozen session intent's Retry while an unrelated bounded operation dispatches", () => {
    const first = dispatch(createNativeOperationPump(), operation("SessionIntent", "play"));
    const frozen = connectionFailed(first.pump, only(first), UNAVAILABLE);
    expect(visibleConnectionFailure(frozen.pump)).toEqual({
      key: "SessionIntent",
      error: UNAVAILABLE,
    });

    const projection = dispatch(
      frozen.pump,
      operation("ListeningProjection", "adopt"),
    );
    const projectionDone = settled(projection.pump, only(projection));

    expect(visibleConnectionFailure(projectionDone.pump)).toEqual({
      key: "SessionIntent",
      error: UNAVAILABLE,
    });
    const queued = dispatch(projectionDone.pump, operation("SessionIntent", "seek"));
    expect(queued.effects).toEqual([]);
    const retried = retry(queued.pump, "SessionIntent");
    expect(ran(retried)).toEqual(["play"]);
    expect(visibleConnectionFailure(retried.pump)).toBeNull();
    expect(ran(settled(retried.pump, only(retried)))).toEqual(["seek"]);
  });

  it("retrying a frozen intent that no longer applies drops it and drains the queue", () => {
    let applies = true;
    const first = dispatch(
      createNativeOperationPump(),
      operation("SessionIntent", "play", () => applies),
    );
    const frozen = connectionFailed(first.pump, only(first), UNAVAILABLE);
    const queued = dispatch(frozen.pump, operation("SessionIntent", "next"));
    applies = false;

    const retried = retry(queued.pump, "SessionIntent");

    expect(ran(retried)).toEqual(["next"]);
    expect(visibleConnectionFailure(retried.pump)).toBeNull();
  });

  it("a reconnected controller drops the ambiguous frozen session intent, drains its queue, and resumes frozen bounded work", () => {
    const { pump, log } = pumpAfter(
      (pump) => dispatch(pump, operation("SessionIntent", "play")),
      (pump) => dispatch(pump, operation("PodcastSettings", "install")),
      (pump) => dispatch(pump, operation("SessionIntent", "seek")),
    );
    expect(log).toEqual(["play", "install"]);
    const play = pump.inFlight;
    if (play === null) throw new Error("play must be in flight");
    const installSequence = pump.latest.get("PodcastSettings");
    const install = {
      ...operation("PodcastSettings", "install"),
      sequence: installSequence ?? -1,
      barrierEpoch: 0,
    };
    const frozenBoth = connectionFailed(
      connectionFailed(pump, play, UNAVAILABLE).pump,
      install,
      UNAVAILABLE,
    );
    expect(visibleConnectionFailure(frozenBoth.pump)?.key).toBe("SessionIntent");

    const resumed = reconnected(frozenBoth.pump);

    expect(ran(resumed)).toEqual(["seek", "install"]);
    expect(visibleConnectionFailure(resumed.pump)).toBeNull();
  });

  it("ignores a late failure from a superseded bounded operation", () => {
    const first = dispatch(createNativeOperationPump(), operation("PodcastSettings", "old"));
    const second = dispatch(first.pump, operation("PodcastSettings", "new"));

    const lateFailure = connectionFailed(second.pump, only(first), UNAVAILABLE);

    expect(visibleConnectionFailure(lateFailure.pump)).toBeNull();
    expect(lateFailure.pump.parked.size).toBe(0);
  });
});

describe("native operation pump: natural-end barrier", () => {
  it("replays a parked intent only once its receipt is acknowledged, then drains the queue", () => {
    const receipt = "receipt-1";
    const first = dispatch(createNativeOperationPump(), operation("SessionIntent", "play"));
    const observed = barrierChanged(first.pump, receipt);
    const parked = barrierRejected(observed.pump, only(first));
    expect(parked.effects).toEqual([]);
    const queued = dispatch(parked.pump, operation("SessionIntent", "seek"));
    expect(queued.effects).toEqual([]);

    const acknowledged = barrierAcknowledged(queued.pump, receipt);

    expect(ran(acknowledged)).toEqual(["play"]);
    const replayed = only(acknowledged);
    expect(replayed.barrierEpoch).toBe(1);
    const cleared = barrierChanged(acknowledged.pump, null);
    expect(cleared.effects).toEqual([]);
    expect(ran(settled(cleared.pump, replayed))).toEqual(["seek"]);
  });

  it("binds a rejection that preceded the receipt to that receipt", () => {
    const first = dispatch(createNativeOperationPump(), operation("SessionIntent", "play"));
    const parked = barrierRejected(first.pump, only(first));
    const observed = barrierChanged(parked.pump, "receipt-1");
    expect(observed.effects).toEqual([]);

    expect(ran(barrierAcknowledged(observed.pump, "receipt-1"))).toEqual(["play"]);
  });

  it("replays a delayed rejection exactly once after its barrier already ended", () => {
    const first = dispatch(createNativeOperationPump(), operation("SessionIntent", "play"));
    const play = only(first);
    const observed = barrierChanged(first.pump, "receipt-1");
    const acknowledged = barrierAcknowledged(observed.pump, "receipt-1");
    expect(acknowledged.effects).toEqual([]);

    const late = barrierRejected(acknowledged.pump, play);

    expect(ran(late)).toEqual(["play"]);
    expect(late.pump.parked.size).toBe(0);
    expect(barrierRejected(late.pump, play).effects).toEqual([]);
  });

  it("releases a parked intent when its receipt is cleared without acknowledgement", () => {
    const first = dispatch(createNativeOperationPump(), operation("SessionIntent", "play"));
    const observed = barrierChanged(first.pump, "receipt-1");
    const parked = barrierRejected(observed.pump, only(first));
    const queued = dispatch(parked.pump, operation("SessionIntent", "seek"));

    const cleared = barrierChanged(queued.pump, null);

    expect(ran(cleared)).toEqual(["play"]);
    expect(ran(settled(cleared.pump, only(cleared)))).toEqual(["seek"]);
  });

  it("drops a parked intent that no longer applies when its receipt is superseded", () => {
    let applies = true;
    const first = dispatch(
      createNativeOperationPump(),
      operation("SessionIntent", "play", () => applies),
    );
    const observed = barrierChanged(first.pump, "receipt-1");
    const parked = barrierRejected(observed.pump, only(first));
    const queued = dispatch(parked.pump, operation("SessionIntent", "load-next"));
    applies = false;

    const superseded = barrierChanged(queued.pump, "receipt-2");

    expect(ran(superseded)).toEqual(["load-next"]);
    expect(superseded.pump.parked.size).toBe(0);
  });

  it("keeps bounded keys latest-wins across the barrier", () => {
    const first = dispatch(createNativeOperationPump(), operation("PodcastSettings", "old"));
    const observed = barrierChanged(first.pump, "receipt-1");
    const parked = barrierRejected(observed.pump, only(first));
    const newer = dispatch(parked.pump, operation("PodcastSettings", "new"));
    expect(ran(newer)).toEqual(["new"]);
    expect(newer.pump.parked.size).toBe(0);

    const acknowledged = barrierAcknowledged(newer.pump, "receipt-1");

    expect(acknowledged.effects).toEqual([]);
  });
});

describe("native operation pump: dismiss bypasses the session queue", () => {
  it("runs Dismiss while a session intent is parked on the barrier", () => {
    const first = dispatch(createNativeOperationPump(), operation("SessionIntent", "play"));
    const observed = barrierChanged(first.pump, "receipt-1");
    const parked = barrierRejected(observed.pump, only(first));

    const dismissed = dispatch(parked.pump, operation("Dismiss", "dismiss"));

    expect(ran(dismissed)).toEqual(["dismiss"]);
    expect(dismissed.pump.inFlight?.sequence).toBe(only(first).sequence);
  });
});

describe("native operation pump: caller-run operations", () => {
  it("a stamped operation owns its key until a newer dispatch supersedes it", () => {
    const stamped = stampOperation(
      createNativeOperationPump(),
      operation("PodcastSettings", "inline"),
    );
    const frozen = connectionFailed(stamped.pump, stamped.operation, UNAVAILABLE);
    expect(visibleConnectionFailure(frozen.pump)?.key).toBe("PodcastSettings");

    const superseded = dispatch(frozen.pump, operation("PodcastSettings", "newer"));

    expect(ran(superseded)).toEqual(["newer"]);
    expect(visibleConnectionFailure(superseded.pump)).toBeNull();
  });
});
