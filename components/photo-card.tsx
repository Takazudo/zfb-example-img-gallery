import { PlaceholderImage } from "./placeholder-image";

export type PhotoCardPhoto = {
  id: number | string;
  title: string;
  src: string;
  width: number;
  height: number;
  blurhash: string | null;
};

type Props = { photo: PhotoCardPhoto; priority?: boolean; srcSet?: string; sizes?: string };

export function PhotoCard({ photo, priority = false, srcSet, sizes }: Props) {
  const responsive = srcSet ? { srcSet, sizes: sizes ?? "(min-width: 48rem) 200px, 100vw" } : {};
  return (
    <li data-photo-id={String(photo.id)}>
      <a href={`/photos/${photo.id}`} class="group block">
        <div data-photo-card-media class="overflow-hidden bg-surface-sunken">
          <PlaceholderImage src={photo.src} alt={photo.title} width={photo.width} height={photo.height}
            blurhash={photo.blurhash} fit="cover" wrapperClass="w-full"
            loading={priority ? "eager" : "lazy"} decoding="async"
            class="block w-full [aspect-ratio:var(--gallery-thumbnail-aspect-ratio)] [object-fit:var(--gallery-thumbnail-object-fit)] [object-position:center] transition-transform duration-200 group-hover:scale-[1.03]" {...responsive} />
        </div>
        <h3 class="mt-vsp-2xs truncate text-small text-ink-soft group-hover:text-ink">{photo.title}</h3>
      </a>
    </li>
  );
}
