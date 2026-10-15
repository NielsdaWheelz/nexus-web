import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";

/** Apply one explicit draft delta without replacing unrelated choices. */
export function setLibraryDestination(
  current: readonly LibraryDestinationSelection[],
  { destination, included }: { destination: LibraryDestinationSelection; included: boolean },
): readonly LibraryDestinationSelection[] {
  if (!included) return current.filter((library) => library.id !== destination.id);
  if (current.some((library) => library.id === destination.id)) return current;
  return [...current, destination];
}
