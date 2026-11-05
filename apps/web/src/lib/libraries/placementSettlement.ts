/** An unanswered absolute placement may settle only from the desired fact or a
 * newer guard. Missing/read-failed facts prove nothing; never rebase a retry. */
export function placementSettlement(input: {
  desired: boolean;
  expected_revision: string;
  expected_removal_revision: string | null;
  observed: { included: boolean; revision: string } | null;
  removal_revision: string | null;
}): "Satisfied" | "Superseded" | "Unknown" {
  if (input.observed?.included === input.desired) return "Satisfied";
  if (input.observed !== null && BigInt(input.observed.revision) > BigInt(input.expected_revision)
    || input.expected_removal_revision !== null && input.removal_revision !== null
      && BigInt(input.removal_revision) > BigInt(input.expected_removal_revision)) return "Superseded";
  return "Unknown";
}
