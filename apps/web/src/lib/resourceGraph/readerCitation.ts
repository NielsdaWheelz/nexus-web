import type { ReaderSourceTarget } from "./readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";

export interface ReaderCitationPreview {
  title?: string;
  excerpt?: string;
  summary?: string;
  meta?: string[];
  copyText?: string;
}

export interface ReaderCitationData {
  index: number;
  preview: ReaderCitationPreview;
  activation: ResourceActivation;
  target: ReaderSourceTarget | null;
}
