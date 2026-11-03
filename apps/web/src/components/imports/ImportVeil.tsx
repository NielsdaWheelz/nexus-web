import styles from "./ImportVeil.module.css";

/** The drag's destination, without an interaction or speech owner. */
export default function ImportVeil({ label }: { readonly label: string }) {
  return <div className={styles.veil} aria-hidden="true"><span>{label}</span></div>;
}
