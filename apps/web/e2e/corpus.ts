import { readFileSync } from "node:fs";
import path from "node:path";

interface BoundedCitationPdfRecipe {
  version: 1;
  title: string;
  author: string;
  subject: string;
  page_count: number;
  findings_per_page: number;
  reference_count: number;
  finding_text: string;
  adversarial_pdf: string;
}

function boundedCitationPdfRecipe(): BoundedCitationPdfRecipe {
  const value = JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        "../../../testdata/pdf/bounded-citation-712.json",
      ),
      "utf8",
    ),
  ) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The bounded citation PDF recipe must be an object.");
  }
  const recipe = value as Record<string, unknown>;
  const expectedKeys = [
    "adversarial_pdf",
    "author",
    "finding_text",
    "findings_per_page",
    "page_count",
    "reference_count",
    "subject",
    "title",
    "version",
  ];
  if (
    Object.keys(recipe).sort().join(",") !== expectedKeys.join(",") ||
    recipe.version !== 1 ||
    recipe.page_count !== 712 ||
    !Number.isInteger(recipe.findings_per_page) ||
    Number(recipe.findings_per_page) < 1 ||
    Number(recipe.findings_per_page) > 48 ||
    !Number.isInteger(recipe.reference_count) ||
    Number(recipe.reference_count) < 1 ||
    typeof recipe.title !== "string" ||
    !recipe.title ||
    typeof recipe.author !== "string" ||
    !recipe.author ||
    typeof recipe.subject !== "string" ||
    !recipe.subject ||
    typeof recipe.finding_text !== "string" ||
    !recipe.finding_text ||
    typeof recipe.adversarial_pdf !== "string" ||
    !recipe.adversarial_pdf.startsWith("%PDF-")
  ) {
    throw new Error("The bounded citation PDF recipe changed shape.");
  }
  return recipe as unknown as BoundedCitationPdfRecipe;
}

const boundedPdfRecipe = boundedCitationPdfRecipe();

const canonicalReaderEpub = Buffer.from(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../testdata/epub/canonical-reader-positions.epub.b64",
    ),
    "utf8",
  ).trim(),
  "base64",
);

export function uniqueCanonicalReaderEpub(runIdentity: string): Buffer {
  const endOfCentralDirectory = canonicalReaderEpub.lastIndexOf(
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  );
  if (endOfCentralDirectory < 0) {
    throw new Error("The canonical reader EPUB has no ZIP end record.");
  }
  const comment = Buffer.from(`nexus-test:${runIdentity}`, "utf8");
  const archive = Buffer.from(
    canonicalReaderEpub.subarray(0, endOfCentralDirectory + 22),
  );
  archive.writeUInt16LE(comment.byteLength, endOfCentralDirectory + 20);
  return Buffer.concat([archive, comment]);
}

function pdfString(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new Error("The bounded PDF corpus must remain printable ASCII.");
  }
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function pdfObject(id: number, body: string | Buffer): Buffer {
  const encoded = typeof body === "string" ? Buffer.from(body, "ascii") : body;
  return Buffer.concat([
    Buffer.from(`${id} 0 obj\n`, "ascii"),
    encoded,
    Buffer.from("\nendobj\n", "ascii"),
  ]);
}

/** Build the manifest-owned 712-page real PDF without a binary fixture or product hook. */
export function boundedCitationPdf(): Buffer {
  const recipe = boundedPdfRecipe;
  const firstPageObject = 4;
  const infoObject = firstPageObject + recipe.page_count * 2;
  const objects: Buffer[] = new Array(infoObject + 1);
  const pageObjects = Array.from(
    { length: recipe.page_count },
    (_value, index) => firstPageObject + index * 2,
  );
  objects[1] = pdfObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects[2] = pdfObject(
    2,
    `<< /Type /Pages /Count ${recipe.page_count} /Kids [${pageObjects.map((id) => `${id} 0 R`).join(" ")}] >>`,
  );
  objects[3] = pdfObject(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  for (let pageIndex = 0; pageIndex < recipe.page_count; pageIndex += 1) {
    const pageObject = firstPageObject + pageIndex * 2;
    const contentObject = pageObject + 1;
    const lines = [
      `${recipe.title} - Study page ${pageIndex + 1} of ${recipe.page_count}`,
      ...Array.from({ length: recipe.findings_per_page }, (_value, findingIndex) => {
        const reference =
          (pageIndex * recipe.findings_per_page + findingIndex) % recipe.reference_count + 1;
        return `Finding ${pageIndex + 1}.${findingIndex + 1}: ${recipe.finding_text} [${reference}].`;
      }),
    ];
    const operators = [
      "BT",
      "/F1 6.5 Tf",
      "48 744 Td",
      "10 TL",
      ...lines.flatMap((line, index) => [
        ...(index === 0 ? [] : ["T*"]),
        `(${pdfString(line)}) Tj`,
      ]),
      "ET",
    ].join("\n");
    const stream = Buffer.from(operators, "ascii");
    objects[pageObject] = pdfObject(
      pageObject,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`,
    );
    objects[contentObject] = pdfObject(
      contentObject,
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.byteLength} >>\nstream\n`, "ascii"),
        stream,
        Buffer.from("\nendstream", "ascii"),
      ]),
    );
  }
  objects[infoObject] = pdfObject(
    infoObject,
    `<< /Title (${pdfString(recipe.title)}) /Author (${pdfString(recipe.author)}) /Subject (${pdfString(recipe.subject)}) >>`,
  );

  const chunks: Buffer<ArrayBufferLike>[] = [
    Buffer.from("%PDF-1.4\n% Nexus manifest-owned corpus\n", "ascii"),
  ];
  const offsets = [0];
  let offset = chunks[0].byteLength;
  for (let id = 1; id <= infoObject; id += 1) {
    offsets[id] = offset;
    chunks.push(objects[id]);
    offset += objects[id].byteLength;
  }
  const xrefOffset = offset;
  chunks.push(
    Buffer.from(
      [
        "xref",
        `0 ${infoObject + 1}`,
        "0000000000 65535 f ",
        ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n `),
        `trailer\n<< /Size ${infoObject + 1} /Root 1 0 R /Info ${infoObject} 0 R >>`,
        `startxref\n${xrefOffset}`,
        "%%EOF",
        "",
      ].join("\n"),
      "ascii",
    ),
  );
  return Buffer.concat(chunks);
}

export function adversarialTruncatedPdf(): Buffer {
  return Buffer.from(boundedPdfRecipe.adversarial_pdf, "ascii");
}
