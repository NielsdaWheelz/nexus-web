/** A progress holder could not safely prepare a state change. */
export class ProgressPreparationError extends Error {
  constructor() {
    super("progress is not ready for this change");
    this.name = "ProgressPreparationError";
  }
}
