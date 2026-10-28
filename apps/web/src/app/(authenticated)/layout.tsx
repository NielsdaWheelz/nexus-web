/** Workspace navigations are admitted to the shared asset shell by middleware.
 * A missed server route resumes that entry; it never boots a second writing app. */
import { redirect } from "next/navigation";
export default function AuthenticatedLayout(): never { redirect("/"); }
