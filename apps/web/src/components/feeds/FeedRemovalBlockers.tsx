import { Fact } from "@/components/feedback/Fact";
import type { Schema } from "@/lib/api/wire";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import styles from "./FeedCommands.module.css";

/** The reviewed destination owns its display name; blockers name current rules. */
export default function FeedRemovalBlockers({ blocked, destinations }: {
  readonly blocked: readonly Schema<"FeedRemovalBlockedOut">[];
  readonly destinations: readonly Pick<Schema<"FeedRemovalDestinationOut">, "library_id" | "name" | "is_default">[];
}) {
  if (blocked.length === 0) return null;
  return <ul className={styles.destinations} aria-label="removal blockers">
    {blocked.map(blocker => {
      const destination = destinations.find(item => item.library_id === blocker.library_id);
      // justify-defect: blockers only name destinations in this same reviewed preview.
      if (destination === undefined) throw new Error("removal blocker has no reviewed destination");
      const name = libraryDisplayName(destination);
      return <li key={`${blocker.library_id}:${blocker.reason}`}><Fact line={blocker.reason === "requires_admin"
        ? { fact: `only a library admin can change ${name}.` }
        : { fact: `active subscriptions in ${name}: ${blocker.feeds.map(feed => feed.title).join(", ")}.`,
          reason: "unsubscribe from these sources in this library before removing their items." }} /></li>;
    })}
  </ul>;
}
