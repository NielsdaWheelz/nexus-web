import { Rss } from "lucide-react";
import { cx } from "@/lib/ui/cx";
import styles from "./PodcastSubscriptionIcon.module.css";

/** Decorative rss. Weight records the observation; `subscribed` paints it gold. */
export default function PodcastSubscriptionIcon({ subscribed }: { readonly subscribed: boolean }) {
  return <Rss className={cx(styles.glyph, subscribed && styles.subscribed)} aria-hidden="true" focusable="false" />;
}
