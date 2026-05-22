export function stateChangingApiHeaders(): { origin: string } {
  return { origin: `http://localhost:${process.env.WEB_PORT ?? "3000"}` };
}
