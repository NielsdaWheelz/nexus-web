import ContributorRoleGroups from "@/components/contributors/ContributorRoleGroups";
import MediaImage from "@/components/ui/MediaImage";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { MediaImageProxySrc } from "@/lib/media/imageProxy";
import styles from "./PodcastOverview.module.css";

export interface PodcastOverviewLink {
  readonly label: string;
  readonly href: string;
}

export default function PodcastOverview({
  title,
  image,
  contributors,
  description,
  facts,
  links,
  note,
  error,
}: {
  readonly title: string;
  readonly image:
    | { readonly kind: "Absent" }
    | { readonly kind: "Remote"; readonly url: string }
    | { readonly kind: "Proxied"; readonly url: MediaImageProxySrc };
  readonly contributors: readonly ContributorCredit[];
  readonly description: string | null;
  readonly facts: readonly string[];
  readonly links: readonly PodcastOverviewLink[];
  readonly note?: string;
  readonly error?: string;
}) {
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        {image.kind === "Remote" ? (
          <MediaImage
            kind="proxied"
            remoteUrl={image.url}
            alt=""
            width={88}
            height={88}
            className={styles.artwork}
          />
        ) : image.kind === "Proxied" ? (
          <MediaImage
            kind="proxy-src"
            src={image.url}
            alt=""
            width={88}
            height={88}
            className={styles.artwork}
          />
        ) : (
          <span className={styles.fallback} aria-hidden="true">
            {title
              .split(/\s+/u)
              .filter(Boolean)
              .slice(0, 2)
              .map((part) => part[0]?.toUpperCase() ?? "")
              .join("") || "P"}
          </span>
        )}
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
            key={`${link.label}:${link.href}`}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {link.label}
          </a>
        ))}
      </div>
      {note ? <p className={styles.note}>{note}</p> : null}
      {error ? (
        <p className={styles.error}>
          <strong>{error}</strong>
        </p>
      ) : null}
    </div>
  );
}
