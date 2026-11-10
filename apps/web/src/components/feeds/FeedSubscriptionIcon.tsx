import * as Icon from "@/lib/ui/icons";
import { cx } from "@/lib/ui/cx";
import styles from "./FeedSubscriptionIcon.module.css";

/** Decorative rss. Weight records the observation; `subscribed` paints it gold. */
export default function FeedSubscriptionIcon({ subscribed }: { readonly subscribed: boolean }) {
  return <Icon.Feed className={cx(styles.glyph, subscribed && styles.subscribed)} aria-hidden="true" focusable="false" />;
}
