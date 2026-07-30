"use client";

import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import { PlayerSpeedControl } from "./PlayerControls";
import PlayerAudioEffectsControls from "./PlayerAudioEffectsControls";
import styles from "./MobileNowPlaying.module.css";

export default function PlayerAudioEffectsSheet({
  active,
  onDismiss,
}: {
  readonly active: boolean;
  readonly onDismiss: () => void;
}) {
  return (
    <MobileSheet
      active={active}
      onDismiss={onDismiss}
      ariaLabel="Audio effects"
      returnFocusFallback={() =>
        document.querySelector<HTMLElement>("[data-player-effects]")
      }
    >
      <div
        className={styles.sheetFrame}
        role="region"
        aria-label="Media player"
      >
        <header className={styles.sheetHeader}>
          <div>
            <span className={styles.kicker}>Listening tools</span>
            <h2 className={styles.sheetTitle}>Audio effects</h2>
          </div>
          <Button variant="ghost" size="lg" onClick={onDismiss}>
            Done
          </Button>
        </header>
        <div className={styles.sheetBody}>
          <PlayerSpeedControl />
          <PlayerAudioEffectsControls />
        </div>
      </div>
    </MobileSheet>
  );
}
