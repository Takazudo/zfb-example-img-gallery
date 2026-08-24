import type { JSX } from "preact";
import { createImagePlaceholder } from "../lib/image-placeholder";

type Props = JSX.ImgHTMLAttributes<HTMLImageElement> & {
  blurhash: string | null;
  fit: "cover" | "contain";
  width: number;
  height: number;
  wrapperClass?: string;
};

/** SSR-only wrapper: without JS, the real image remains fully visible. */
export function PlaceholderImage({ blurhash, fit, wrapperClass = "", ...image }: Props) {
  const placeholder = createImagePlaceholder(blurhash, image.width, image.height);
  if (!placeholder) return <img {...image} />;

  return (
    <span
      data-image-placeholder="true"
      data-placeholder-fit={fit}
      class={`relative block ${wrapperClass}`.trim()}
      style={`--image-placeholder:url("${placeholder.dataUri}")`}
    >
      <img {...image} data-placeholder-image="true" />
    </span>
  );
}
