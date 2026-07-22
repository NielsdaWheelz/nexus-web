import { describe, expect, it } from "vitest";
import { runBoundedTasks } from "./runBoundedTasks";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("runBoundedTasks", () => {
  it("starts in order, respects the bound, joins all work, and preserves result order", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;

    const result = runBoundedTasks({
      items: ["a", "b", "c"],
      concurrency: 2,
      run: async (_item, index) => {
        started.push(index);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const value = await gates[index]!.promise;
        active -= 1;
        return value;
      },
    });

    expect(started).toEqual([0, 1]);
    gates[1]!.resolve("second");
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[2]!.resolve("third");
    gates[0]!.resolve("first");

    await expect(result).resolves.toEqual([
      { kind: "Fulfilled", value: "first" },
      { kind: "Fulfilled", value: "second" },
      { kind: "Fulfilled", value: "third" },
    ]);
    expect(maximumActive).toBe(2);
  });

  it("collects rejections without failing fast", async () => {
    const completed: number[] = [];
    const outcomes = await runBoundedTasks({
      items: [1, 2, 3],
      concurrency: 2,
      run: async (item) => {
        if (item === 2) throw new Error("two failed");
        completed.push(item);
        return item * 10;
      },
    });

    expect(completed).toEqual([1, 3]);
    expect(outcomes[0]).toEqual({ kind: "Fulfilled", value: 10 });
    expect(outcomes[1]).toMatchObject({
      kind: "Rejected",
      error: new Error("two failed"),
    });
    expect(outcomes[2]).toEqual({ kind: "Fulfilled", value: 30 });
  });

  it("returns an empty result without starting work", async () => {
    let started = false;
    await expect(
      runBoundedTasks({
        items: [],
        concurrency: 2,
        run: async () => {
          started = true;
          return 1;
        },
      }),
    ).resolves.toEqual([]);
    expect(started).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid concurrency %s before starting",
    async (concurrency) => {
      let started = false;
      await expect(
        runBoundedTasks({
          items: [1],
          concurrency,
          run: async () => {
            started = true;
            return 1;
          },
        }),
      ).rejects.toThrow("Task concurrency must be a positive integer");
      expect(started).toBe(false);
    },
  );
});
