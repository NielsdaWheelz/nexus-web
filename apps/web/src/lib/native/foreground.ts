/** The admitted native document publishes this fact; browser visibility is separate. */
let foreground = false;
const listeners = new Set<() => void>();
export const nativeIsForeground = (): boolean => foreground;
export function subscribeNativeForeground(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function setNativeForeground(active: boolean): void {
  if (foreground === active) return;
  foreground = active;
  for (const listener of listeners) listener();
}
