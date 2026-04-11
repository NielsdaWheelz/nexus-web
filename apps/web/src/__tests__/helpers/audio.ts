export function setAudioMetrics(audio: HTMLAudioElement, values: { duration: number; currentTime: number }): void {
  Object.defineProperty(audio, "duration", {
    configurable: true,
    value: values.duration,
  });
  audio.currentTime = values.currentTime;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
