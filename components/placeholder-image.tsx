import type { JSX } from "@takazudo/zfb/zudo-react/jsx-runtime";
import { createImagePlaceholder } from "../lib/image-placeholder";

type Props = Omit<JSX.IntrinsicElements["img"], "width" | "height"> & {
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
      // Single quotes serialize unescaped: 10 fewer bytes per card in the 512 KiB history snapshot.
      style={`--image-placeholder:url('${placeholder.dataUri}')`}
    >
      <img {...image} data-placeholder-image="true" />
    </span>
  );
}
