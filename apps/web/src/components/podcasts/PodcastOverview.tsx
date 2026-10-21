import { ContributorRoleGroups } from "@/components/contributors/ContributorCredits";
import { FeedbackStatus } from "@/components/feedback/Feedback";
import PodcastArtwork, { type PodcastArtworkSource } from "./PodcastArtwork";
import type { ContributorCredit } from "@/lib/contributors/credits";
import styles from "./PodcastOverview.module.css";

/** A show's artwork, byline, summary, fact badges and outbound links. */
export default function PodcastOverview({
  title,
  image,
  contributors,
  description,
  facts,
  links,
  note,
}: {
  readonly title: string;
  readonly image: PodcastArtworkSource;
  readonly contributors: readonly ContributorCredit[];
  readonly description: string | null;
  readonly facts: readonly string[];
  readonly links: readonly { readonly label: string; readonly href: string }[];
  readonly note?: string;
}) {
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <PodcastArtwork title={title} image={image} size={88} className={styles.artwork} />
        <div className={styles.copy}>
          <ContributorRoleGroups
            credits={[...contributors]}
            className={styles.byline}
          />
          <p>{description?.trim() || "No summary from source."}</p>
        </div>
      </div>
      <div className={styles.meta}>
        {facts.map((fact) => (
          <span key={fact} className={styles.badge}>
            {fact}
          </span>
        ))}
        {links.map((link) => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {link.label}
          </a>
        ))}
      </div>
      {note ? <FeedbackStatus content={{ tone: "Neutral", title: note }} announcement="None" /> : null}
    </div>
  );
}
