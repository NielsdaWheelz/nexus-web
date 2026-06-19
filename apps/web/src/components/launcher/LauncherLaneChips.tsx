"use client";

import Chip from "@/components/ui/Chip";
import { LANE_LABEL, SELECTABLE_LANES } from "@/lib/launcher/model";
import type { LauncherController } from "./useLauncherController";
import styles from "./launcher.module.css";

// The visible affordance for every lane (AC-4): a pressable ui/Chip per lane. Clicking a
// lane selects it; clicking the active lane clears back to the blended `all` view. The
// blended `all` is the cleared (no-chip) state. tabIndex -1 keeps focus on the input.
export default function LauncherLaneChips({ controller }: { controller: LauncherController }) {
  return (
    <div className={styles.laneChips} role="group" aria-label="Lanes">
      {SELECTABLE_LANES.map((lane) => {
        const active = controller.lane === lane;
        return (
          <Chip
            key={lane}
            size="sm"
            pressed={active}
            tabIndex={-1}
            onPressedChange={() => (active ? controller.clearLane() : controller.setLane(lane))}
          >
            {LANE_LABEL[lane]}
          </Chip>
        );
      })}
    </div>
  );
}
