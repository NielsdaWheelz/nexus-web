/**
 * The scroll behavior honoring the user's reduced-motion preference: smooth
 * normally, instant ("auto") when the OS requests reduced motion.
 */
export function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
