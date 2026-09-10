/**
 * The WCAG 2.1 contrast formula, owned once for every proof that measures a
 * rendered pair. Callers bring their own way of reaching an opaque sRGB triple:
 * an already-opaque computed colour parses with `parseRgb`, while a stack of
 * translucent layers has to be composited (on a canvas, so the browser resolves
 * every colour space it may serialize) before it is a colour at all.
 */

/** The channels of an opaque computed colour. */
export function parseRgb(color: string): readonly [number, number, number] {
  const match = /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/u.exec(
    color,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Unsupported computed color: ${color}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** WCAG 2.1 contrast ratio between two opaque sRGB colours. */
export function contrastRatio(
  foreground: readonly [number, number, number],
  background: readonly [number, number, number],
): number {
  const luminance = ([red, green, blue]: readonly [number, number, number]) => {
    const channel = (value: number) => {
      const unit = value / 255;
      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    return (
      0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    );
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const [lighter, darker] =
    foregroundLuminance >= backgroundLuminance
      ? [foregroundLuminance, backgroundLuminance]
      : [backgroundLuminance, foregroundLuminance];
  return (lighter + 0.05) / (darker + 0.05);
}
