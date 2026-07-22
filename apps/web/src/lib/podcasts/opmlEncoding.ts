export class PodcastOpmlEncodingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PodcastOpmlEncodingError";
  }
}

export function decodePodcastOpmlBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PodcastOpmlEncodingError("OPML files must use UTF-8 encoding.", {
      cause: error,
    });
  }
}
