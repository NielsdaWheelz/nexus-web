import type { Schema } from "@/lib/api/wire";
import type { ContributorHandle } from "@/lib/contributors/handle";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { Presence } from "@/lib/api/presence";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { MediaSummary } from "@/lib/media/mediaSummary";

export type ContributorCredit = Schema<"ContributorCreditOut">;

export type ContributorSearchItem = Omit<Schema<"ContributorSearchItemOut">, "handle"> & {
  handle: ContributorHandle;
};

export type ContributorSearchPage = Omit<Schema<"ContributorSearchPageOut">, "contributors"> & {
  contributors: ContributorSearchItem[];
};

export type ContributorDetail = Omit<Schema<"ContributorDetailOut">, "handle" | "actionSubject"> & {
  handle: ContributorHandle;
  actionSubject: ResourceActionSubject;
};

export type ContributorWorkItem =
  | (Omit<Schema<"MediaContributorWorkItemOut">, "mediaSummary" | "actionSubject"> & {
      mediaSummary: MediaSummary;
      actionSubject: ResourceActionSubject;
    })
  | (Omit<Schema<"PodcastContributorWorkItemOut">, "date" | "actionSubject"> & {
      date: Presence<PublicationDate>;
      actionSubject: ResourceActionSubject;
    })
  | (Omit<Schema<"ExternalContributorWorkItemOut">, "date"> & {
      date: Presence<PublicationDate>;
    });

export interface MediaAuthorCredit {
  contributorHandle: ContributorHandle;
  href: string;
  displayName: string;
  creditedName: string;
}

export interface MediaAuthors {
  authorMode: "automatic" | "manual";
  authors: MediaAuthorCredit[];
  canEditAuthors: boolean;
}

/** One editor row's binding: an existing visible contributor, or a new person. */
export type AuthorBinding =
  | { kind: "existing"; contributorHandle: ContributorHandle }
  | { kind: "new"; displayName: string };

export interface MediaAuthorsManualBody {
  clientMutationId: string;
  mode: "manual";
  authors: Array<{ creditedName: string; binding: AuthorBinding }>;
}

export interface MediaAuthorsAutomaticBody {
  clientMutationId: string;
  mode: "automatic";
}

export type MediaAuthorsPutBody = MediaAuthorsManualBody | MediaAuthorsAutomaticBody;
