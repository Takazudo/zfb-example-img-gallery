import { PlaceholderImage } from "./placeholder-image";
import { FavoriteControl } from "./favorite-control";

export type PhotoCardPhoto = {
  id: number | string;
  title: string;
  src: string;
  width: number;
  height: number;
  blurhash: string | null;
  isFavorited?: boolean;
};

type Props = {
  photo: PhotoCardPhoto;
  priority?: boolean;
  srcSet?: string;
  sizes?: string;
  viewerId?: number | null;
  returnTo?: string;
};

export function PhotoCard({ photo, priority = false, srcSet, sizes, viewerId = null, returnTo }: Props) {
  const responsive = srcSet ? { srcSet, sizes: sizes ?? "(min-width: 48rem) 200px, 100vw" } : {};
  return (
    <li data-photo-id={String(photo.id)} class="photo-card">
      <div data-photo-card-media-wrapper class="photo-card-media-wrapper">
        <a href={`/photos/${photo.id}`} class="photo-card-link">
          <div data-photo-card-media class="photo-card-media">
            <PlaceholderImage src={photo.src} alt={photo.title} width={photo.width} height={photo.height}
              blurhash={photo.blurhash} fit="cover" wrapperClass="w-full"
              loading={priority ? "eager" : "lazy"} decoding="async"
              class="photo-card-image" {...responsive} />
          </div>
        </a>
        <FavoriteControl
          photoId={photo.id}
          title={photo.title}
          favorited={photo.isFavorited ?? false}
          viewerId={viewerId}
          returnTo={returnTo ?? `/photos/${photo.id}`}
        />
      </div>
      <h3 class="photo-card-title">
        <a href={`/photos/${photo.id}`} class="photo-card-link">{photo.title}</a>
      </h3>
    </li>
  );
}
