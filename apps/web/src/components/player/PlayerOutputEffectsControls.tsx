"use client";

import {
  usePlayerCommands,
  usePlayerSettings,
} from "@/lib/player/globalPlayer";
import {
  normalizeVolumeBoostLevel,
  type OutputEffectsVolumeBoost,
} from "@/lib/player/outputEffects";
import Select from "@/components/ui/Select";
import styles from "./PlayerControls.module.css";

const VOLUME_BOOST_OPTIONS: readonly {
  readonly value: OutputEffectsVolumeBoost;
  readonly label: string;
}[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low (+3 dB)" },
  { value: "medium", label: "Medium (+6 dB)" },
  { value: "high", label: "High (+9 dB)" },
];

export default function PlayerOutputEffectsControls() {
  const settings = usePlayerSettings();
  const commands = usePlayerCommands();

  if (!settings.outputEffectsAvailable) {
    return (
      <div className={styles.effectsControls}>
        <p>Output effects unavailable for this source.</p>
      </div>
    );
  }

  return (
    <div className={styles.effectsControls}>
      <label className={styles.effectsSelectSetting}>
        <span>Volume boost</span>
        <Select
          size="lg"
          value={settings.outputEffects.volumeBoost}
          onChange={(event) =>
            commands.setOutputEffects({
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
      <label className={styles.effectsToggleSetting}>
        <input
          type="checkbox"
          checked={settings.outputEffects.mono}
          onChange={(event) =>
            commands.setOutputEffects({ mono: event.currentTarget.checked })
          }
        />
        <span>Mono audio</span>
      </label>
    </div>
  );
}
