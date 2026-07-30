export function matchesPaneFilterQuery(
  query: string,
  fields: readonly string[],
): boolean {
  const needle = query.trim().normalize("NFC").toLowerCase();
  return (
    needle.length === 0 ||
    fields.some((field) =>
      field.normalize("NFC").toLowerCase().includes(needle),
    )
  );
}
