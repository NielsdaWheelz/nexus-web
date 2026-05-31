import OpenGraphImage, {
  alt as openGraphAlt,
  contentType as openGraphContentType,
  size as openGraphSize,
} from "./opengraph-image";

export const alt = openGraphAlt;
export const size = openGraphSize;
export const contentType = openGraphContentType;

export default function TwitterImage() {
  return OpenGraphImage();
}
