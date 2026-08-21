export type PhotoCardPhoto = {
  id: number | string;
  title: string;
  src: string;
  width: number;
  height: number;
};

type Props = { photo: PhotoCardPhoto; priority?: boolean; srcSet?: string; sizes?: string };

export function PhotoCard({ photo, priority = false, srcSet, sizes }: Props) {
  const responsive = srcSet ? { srcSet, sizes: sizes ?? "(min-width: 48rem) 200px, 100vw" } : {};
  return (
    <li>
      <a href={`/photos/${photo.id}`} class="group block">
        <div class="aspect-square overflow-hidden bg-surface-sunken">
          <img src={photo.src} alt={photo.title} width={photo.width} height={photo.height}
            loading={priority ? "eager" : "lazy"} decoding="async"
            class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" {...responsive} />
        </div>
        <h3 class="mt-vsp-2xs truncate text-small text-ink-soft group-hover:text-ink">{photo.title}</h3>
      </a>
    </li>
  );
}
