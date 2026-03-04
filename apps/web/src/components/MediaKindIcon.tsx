import {
  BookOpen,
  FileText,
  Globe,
  Mic,
  Video,
} from "lucide-react";

interface MediaKindIconProps {
  kind: string;
  size?: number;
}

export default function MediaKindIcon({ kind, size = 18 }: MediaKindIconProps) {
  if (kind === "podcast_episode") {
    return <Mic size={size} aria-hidden="true" />;
  }
  if (kind === "video") {
    return <Video size={size} aria-hidden="true" />;
  }
  if (kind === "epub") {
    return <BookOpen size={size} aria-hidden="true" />;
  }
  if (kind === "pdf") {
    return <FileText size={size} aria-hidden="true" />;
  }
  return <Globe size={size} aria-hidden="true" />;
}
