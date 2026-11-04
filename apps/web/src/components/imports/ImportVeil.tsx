import { createPortal } from "react-dom";
import { useOverlayContainer } from "@/lib/ui/overlay";
import styles from "./ImportVeil.module.css";

/** The drag's destination, without an interaction or speech owner. */
export default function ImportVeil({ label }: { readonly label: string }) {
  const container = useOverlayContainer();
  return container === null ? null : createPortal(<div className={styles.veil} aria-hidden="true"><span>{label}</span></div>, container);
}
