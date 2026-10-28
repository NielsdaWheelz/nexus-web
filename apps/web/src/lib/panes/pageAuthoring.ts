/** A latent page's identity belongs to its authoring visit. Materializing that
 * exact page changes its address, while its composer and return memory survive. */
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
export type NewPageIdentity = { accountId: string; id: string };
export const NEW_PAGE_IDENTITY = definePaneVisitDataKey<NewPageIdentity>("new-page-identity");
