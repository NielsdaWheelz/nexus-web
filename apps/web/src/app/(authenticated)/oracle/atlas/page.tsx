import { redirect } from "next/navigation";

// The oracle-scoped atlas is absorbed by the grand atlas READINGS layer
// (grand-atlas §7.5). This route only exists to redirect legacy links.
export default function Page() {
  redirect("/atlas?layer=readings");
}
