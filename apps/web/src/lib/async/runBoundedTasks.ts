export type TaskOutcome<T> =
  | { kind: "Fulfilled"; value: T }
  | { kind: "Rejected"; error: unknown };

export async function runBoundedTasks<TInput, TOutput>({
  items,
  concurrency,
  run,
}: {
  items: readonly TInput[];
  concurrency: number;
  run(item: TInput, index: number): Promise<TOutput>;
}): Promise<readonly TaskOutcome<TOutput>[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError("Task concurrency must be a positive integer.");
  }
  if (items.length === 0) return [];

  const outcomes = new Array<TaskOutcome<TOutput>>(items.length);
  const tasks = items.map((item, index) => ({ item, index }));
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex];
      nextIndex += 1;
      if (task === undefined) {
        throw new Error("Bounded task index escaped the prepared task set.");
      }
      try {
        outcomes[task.index] = {
          kind: "Fulfilled",
          value: await run(task.item, task.index),
        };
      } catch (error) {
        outcomes[task.index] = { kind: "Rejected", error };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return outcomes;
}
