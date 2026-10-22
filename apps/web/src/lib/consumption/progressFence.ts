/** A holder retained unsaved progress and could not safely prepare a state write. */
export class ProgressPreparationError extends Error {
  constructor() {
    super("progress could not be saved");
    this.name = "ProgressPreparationError";
  }
}
