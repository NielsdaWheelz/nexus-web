import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  notePagesResource,
  type NotePagesResourceParams,
} from "@/lib/api/resource";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import { isLocalDate } from "@/lib/localDate";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import {
  expectArray,
  expectExactRecord,
  expectIsoInstant,
  expectNonemptyString,
  expectString,
} from "@/lib/validation";

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PAGE_TITLE_CODEPOINTS = 200;

export interface NotePageSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly actionSubject: ResourceActionSubject;
}

export interface DailyPageSummary {
  readonly localDate: string;
}

export interface NotePage extends NotePageSummary {
  readonly dailyPage: Presence<DailyPageSummary>;
}

export function decodeNotePageId(raw: unknown, context: string): string {
  const id = expectString(raw, context);
  if (!CANONICAL_UUID_RE.test(id)) {
    throw new TypeError(`${context} must be a canonical lowercase UUID`);
  }
  return id;
}

export function decodeNoteLocalDate(raw: unknown, context: string): string {
  const localDate = expectString(raw, context);
  if (!isLocalDate(localDate)) {
    throw new TypeError(`${context} must be a valid YYYY-MM-DD date`);
  }
  return localDate;
}

function decodePageTitle(raw: unknown, context: string): string {
  const title = expectNonemptyString(raw, context);
  if ([...title].length > MAX_PAGE_TITLE_CODEPOINTS) {
    throw new TypeError(
      `${context} must contain at most ${MAX_PAGE_TITLE_CODEPOINTS} codepoints`,
    );
  }
  return title;
}

function decodePageFields(
  page: Record<string, unknown>,
  context: string,
): NotePageSummary {
  const id = decodeNotePageId(page.id, `${context}.id`);
  const title = decodePageTitle(page.title, `${context}.title`);
  const updatedAt = expectIsoInstant(page.updatedAt, `${context}.updatedAt`);
  return {
    id,
    title,
    updatedAt,
    actionSubject: { ref: canonicalResourceRef({ scheme: "page", id }) },
  };
}

export function decodeNotePageSummary(
  raw: unknown,
  context = "note page summary",
): NotePageSummary {
  return decodePageFields(
    expectExactRecord(raw, ["id", "title", "updatedAt"], context),
    context,
  );
}

export function decodeNotePage(
  raw: unknown,
  context = "note page",
): NotePage {
  const page = expectExactRecord(
    raw,
    ["id", "title", "updatedAt", "dailyPage"],
    context,
  );
  return {
    ...decodePageFields(page, context),
    dailyPage: decodePresence(page.dailyPage, (value) => {
      const dailyPage = expectExactRecord(
        value,
        ["localDate"],
        `${context}.dailyPage.value`,
      );
      return {
        localDate: decodeNoteLocalDate(
          dailyPage.localDate,
          `${context}.dailyPage.value.localDate`,
        ),
      };
    }),
  };
}

export function decodeNotePagesEnvelope(raw: unknown): readonly NotePageSummary[] {
  const envelope = expectExactRecord(raw, ["data"], "notes pages response");
  const data = expectExactRecord(
    envelope.data,
    ["pages"],
    "notes pages response.data",
  );
  return expectArray(
    data.pages,
    (page, index) =>
      decodeNotePageSummary(page, `notes pages response.data.pages[${index}]`),
    "notes pages response.data.pages",
  );
}

export function decodeNotePageEnvelope(raw: unknown): NotePage {
  const envelope = expectExactRecord(raw, ["data"], "note page response");
  return decodeNotePage(envelope.data, "note page response.data");
}

export async function loadNotePages(
  request: ResourceFetcher,
  params: NotePagesResourceParams,
): Promise<readonly NotePageSummary[]> {
  return decodeNotePagesEnvelope(await request(notePagesResource, params));
}
