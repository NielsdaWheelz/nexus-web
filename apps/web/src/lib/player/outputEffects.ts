export type OutputEffectsVolumeBoost = "off" | "low" | "medium" | "high";

export interface OutputEffectsState {
  volumeBoost: OutputEffectsVolumeBoost;
  mono: boolean;
}

export const OUTPUT_EFFECTS_DEFAULTS: OutputEffectsState = {
  volumeBoost: "off",
  mono: false,
};

const OUTPUT_EFFECTS_STORAGE_KEYS = {
  volumeBoost: "podcast_effects_volume_boost",
  mono: "podcast_effects_mono",
} as const;

export const COMPRESSOR_DEFAULTS = {
  threshold: -6,
  knee: 12,
  ratio: 4,
  attack: 0.003,
  release: 0.25,
} as const;

export const VOLUME_BOOST_GAIN_BY_LEVEL: Record<
  OutputEffectsVolumeBoost,
  number
> = {
  off: 1,
  low: 1.4,
  medium: 2,
  high: 2.8,
};

export function normalizeVolumeBoostLevel(
  value: string | null | undefined,
): OutputEffectsVolumeBoost {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "off";
}

function parseStoredBoolean(
  value: string | null,
  fallbackValue: boolean,
): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallbackValue;
}

export function readOutputEffectsFromStorage(
  storage: Storage,
): OutputEffectsState {
  return {
    volumeBoost: normalizeVolumeBoostLevel(
      storage.getItem(OUTPUT_EFFECTS_STORAGE_KEYS.volumeBoost),
    ),
    mono: parseStoredBoolean(
      storage.getItem(OUTPUT_EFFECTS_STORAGE_KEYS.mono),
      OUTPUT_EFFECTS_DEFAULTS.mono,
    ),
  };
}

export function writeOutputEffectsToStorage(
  storage: Storage,
  effects: OutputEffectsState,
): void {
  storage.setItem(OUTPUT_EFFECTS_STORAGE_KEYS.volumeBoost, effects.volumeBoost);
  storage.setItem(OUTPUT_EFFECTS_STORAGE_KEYS.mono, String(effects.mono));
}

export function areOutputEffectsActive(effects: OutputEffectsState): boolean {
  return effects.mono || effects.volumeBoost !== "off";
}
