export function deepLinkBack(): void {
  if (typeof window !== "undefined") {
    window.location.href = "nexus-share://done";
  }
}
