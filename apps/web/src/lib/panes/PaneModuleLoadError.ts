/** Import rejection identifies a stage, not whether delivery or evaluation failed. */
export class PaneModuleLoadError extends Error {
  constructor(cause: unknown) {
    super("pane module could not open", { cause });
    this.name = "PaneModuleLoadError";
  }
}
