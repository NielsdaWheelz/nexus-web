export type AudioEffectsVolumeBoost = "off" | "low" | "medium" | "high";

export interface AudioEffectsState {
  silenceTrim: boolean;
  volumeBoost: AudioEffectsVolumeBoost;
  mono: boolean;
}

export const AUDIO_EFFECTS_DEFAULTS: AudioEffectsState = {
  silenceTrim: false,
  volumeBoost: "off",
  mono: false,
};

export const AUDIO_EFFECTS_STORAGE_KEYS = {
  silenceTrim: "podcast_effects_silence_trim",
  volumeBoost: "podcast_effects_volume_boost",
  mono: "podcast_effects_mono",
} as const;

export const SILENCE_TRIM_THRESHOLD_DB = -45;
export const SILENCE_TRIM_MIN_DURATION_MS = 400;
export const SILENCE_TRIM_PLAYBACK_RATE = 6;
export const SILENCE_TRIM_ANALYSER_FFT_SIZE = 256;

export const COMPRESSOR_DEFAULTS = {
  threshold: -6,
  knee: 12,
  ratio: 4,
  attack: 0.003,
  release: 0.25,
} as const;

export const VOLUME_BOOST_GAIN_BY_LEVEL: Record<AudioEffectsVolumeBoost, number> = {
  off: 1,
  low: 1.4,
  medium: 2,
  high: 2.8,
};

export function normalizeVolumeBoostLevel(
  value: string | null | undefined
): AudioEffectsVolumeBoost {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "off";
}

function parseStoredBoolean(
  value: string | null,
  fallbackValue: boolean
): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallbackValue;
}

export function readAudioEffectsFromStorage(storage: Storage): AudioEffectsState {
  return {
    silenceTrim: parseStoredBoolean(
      storage.getItem(AUDIO_EFFECTS_STORAGE_KEYS.silenceTrim),
      AUDIO_EFFECTS_DEFAULTS.silenceTrim
    ),
    volumeBoost: normalizeVolumeBoostLevel(
      storage.getItem(AUDIO_EFFECTS_STORAGE_KEYS.volumeBoost)
    ),
    mono: parseStoredBoolean(
      storage.getItem(AUDIO_EFFECTS_STORAGE_KEYS.mono),
      AUDIO_EFFECTS_DEFAULTS.mono
    ),
  };
}

export function writeAudioEffectsToStorage(
  storage: Storage,
  effects: AudioEffectsState
): void {
  storage.setItem(AUDIO_EFFECTS_STORAGE_KEYS.silenceTrim, String(effects.silenceTrim));
  storage.setItem(AUDIO_EFFECTS_STORAGE_KEYS.volumeBoost, effects.volumeBoost);
  storage.setItem(AUDIO_EFFECTS_STORAGE_KEYS.mono, String(effects.mono));
}

export function areAudioEffectsActive(effects: AudioEffectsState): boolean {
  return effects.silenceTrim || effects.mono || effects.volumeBoost !== "off";
}

export function calculateRmsDb(samples: ArrayLike<number>): number {
  if (!samples.length) {
    return -100;
  }
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms <= 0) {
    return -100;
  }
  return 20 * Math.log10(rms);
}
