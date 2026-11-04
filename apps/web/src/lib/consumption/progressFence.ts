export const PROGRESS_PREPARATION_FACT = "couldn’t prepare the reading or listening position.";

/** A progress holder could not safely prepare a state change. */
export class ProgressPreparationError extends Error {
  constructor() {
    super("progress is not ready for this change");
    this.name = "ProgressPreparationError";
  }
}
