"use client";

import {
  usePlayerCommands,
  usePlayerSettings,
  usePlayerTimeline,
} from "@/lib/player/globalPlayer";
import {
  normalizeVolumeBoostLevel,
  type AudioEffectsVolumeBoost,
} from "@/lib/player/audioEffects";
import Select from "@/components/ui/Select";
import styles from "./PlayerControls.module.css";

const VOLUME_BOOST_OPTIONS: readonly {
  readonly value: AudioEffectsVolumeBoost;
  readonly label: string;
}[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low (+3 dB)" },
  { value: "medium", label: "Medium (+6 dB)" },
  { value: "high", label: "High (+9 dB)" },
];

export default function PlayerAudioEffectsControls() {
  const settings = usePlayerSettings();
  const commands = usePlayerCommands();

  return (
    <div className={styles.effectsControls}>
      {!settings.audioEffectsAvailable ? (
        <p>Audio effects unavailable for this source.</p>
      ) : null}
      <label className={styles.setting}>
        <input
          type="checkbox"
          disabled={!settings.audioEffectsAvailable}
          checked={settings.audioEffects.silenceTrim}
          onChange={(event) =>
            commands.setAudioEffects({
              silenceTrim: event.currentTarget.checked,
            })
          }
        />
        <span>Silence trimming</span>
      </label>
      <label className={styles.setting}>
        <span>Volume boost</span>
        <Select
          size="sm"
          disabled={!settings.audioEffectsAvailable}
          value={settings.audioEffects.volumeBoost}
          onChange={(event) =>
            commands.setAudioEffects({
              volumeBoost: normalizeVolumeBoostLevel(event.currentTarget.value),
            })
          }
        >
          {VOLUME_BOOST_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </label>
      <label className={styles.setting}>
        <input
          type="checkbox"
          disabled={!settings.audioEffectsAvailable}
          checked={settings.audioEffects.mono}
          onChange={(event) =>
            commands.setAudioEffects({ mono: event.currentTarget.checked })
          }
        />
        <span>Mono audio</span>
      </label>
      <PlayerAudioEffectsFeedback />
    </div>
  );
}

function PlayerAudioEffectsFeedback() {
  const timeline = usePlayerTimeline();
  return (
    <div className={styles.effectsFeedback}>
      <span>
        Time saved: {(timeline.silenceTimeSavedMs / 1000).toFixed(1)}s
      </span>
      {timeline.isSilenceTrimming ? (
        <span className={styles.trimming}>Trimming silence</span>
      ) : null}
    </div>
  );
}
