"use client";

// A recognised document embed as a card in its placeholder: provider and
// state, title and description, and its actions (open the child media, open
// the original, or inspect a failed article's import). Cards sit outside the canonical text.
import type { DocumentEmbed } from "@/lib/documentReader/model";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import styles from "./media.module.css";

const PROVIDER: Record<DocumentEmbed["provider"], string> = {
  youtube: "YouTube",
  x: "X",
  substack: "Substack",
  vimeo: "Vimeo",
  spotify: "Spotify",
  generic: "Embedded content",
  unknown: "Unknown provider",
};

/** An http(s) url or an in-app path; anything else is no link. */
function safeHref(value: string | null | undefined): string | null {
  const href = value?.trim();
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    return ["http:", "https:"].includes(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

export default function EmbedCard({ embed }: { readonly embed: DocumentEmbed }) {
  const runtime = usePaneRuntime();
  const { display, target } = embed;
  const article = embed.provider === "x" && embed.kind === "link_preview";
  const thumbnail = safeHref(target.thumbnail_url);
  const title = target.title?.trim() ?? null;
  const description = display.description?.trim() ?? null;
  return (
    <figure
      className={styles.embed}
      data-document-embed-state={display.mode}
      aria-label={description ? `${display.label}: ${description}` : display.label}
    >
      {thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element -- justify-eslint-override: a provider's own thumbnail url, shown as given
        <img src={thumbnail} alt="" loading="lazy" decoding="async" />
      ) : null}
      <figcaption>
        <span className={styles.kind}>
          {PROVIDER[embed.provider]}
          {article || display.mode === null ? null : ` · ${display.mode[0].toUpperCase() + display.mode.slice(1)}`}
        </span>
        {article ? null : <strong>{display.label}</strong>}
        {title || description ? <p>{title || description}</p> : null}
        {title && description && description !== title ? (
          <p>{description}</p>
        ) : null}
        <span className={styles.embedActions}>
          {display.actions.map((action) => {
            const href =
              safeHref(action.href) ??
              (action.kind === "open_child_media" && target.media_id
                ? `/media/${target.media_id}`
                : action.kind === "open_original"
                  ? (safeHref(embed.canonical_url.value) ?? safeHref(embed.source_url.value))
                  : null);
            const external = href?.startsWith("http");
            return action.disabled || !href ? (
              <span key={action.kind} aria-disabled="true">
                {action.label}
              </span>
            ) : (
              <a
                key={action.kind}
                href={href}
                data-workspace-rich-target={action.kind === "view_import" ? "true" : undefined}
                onClick={action.kind === "view_import" ? (event) => activateTargetLink({
                  event, runtime, href,
                  secondaryActivation: { surfaceId: "import-detail" },
                }) : undefined}
                {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {action.label}
              </a>
            );
          })}
        </span>
      </figcaption>
    </figure>
  );
}
