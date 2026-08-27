import { PlaceholderImage } from "./placeholder-image";
import { FavoriteControl } from "./favorite-control";
import {
  encodeGalleryLayoutClass,
  getGalleryLayoutRoles,
} from "../lib/gallery-layout-roles";

export type PhotoCardPhoto = {
  id: number | string;
  ownerId?: number;
  title: string;
  src: string;
  width: number;
  height: number;
  blurhash: string | null;
  isFavorited?: boolean;
};

type Props = {
  photo: PhotoCardPhoto;
  absoluteIndex?: number;
  priority?: boolean;
  srcSet?: string;
  sizes?: string;
  viewerId?: number | null;
  returnTo?: string;
  selectable?: boolean;
};

function DeleteIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" class="size-6"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" /></svg>;
}

export function PhotoCard({ photo, absoluteIndex = 0, priority = false, srcSet, sizes, viewerId = null, returnTo, selectable = false }: Props) {
  const responsive = srcSet ? { srcSet, sizes: sizes ?? "(min-width: 48rem) 200px, 100vw" } : {};
  const owned = viewerId !== null && photo.ownerId === viewerId;
  const safeReturnTo = returnTo ?? `/photos/${photo.id}`;
  const roles = getGalleryLayoutRoles(absoluteIndex, photo.width, photo.height);
  return (
    <li
      data-photo-id={String(photo.id)}
      class={`photo-card ${encodeGalleryLayoutClass(absoluteIndex)}`}
      style={`--a:${roles.intrinsicAspectRatio}`}
    >
      <div data-photo-card-media-wrapper class="photo-card-media-wrapper">
        <a href={`/photos/${photo.id}`} class="photo-card-link">
          <div data-photo-card-media class="photo-card-media">
            <PlaceholderImage src={photo.src} alt={photo.title} width={photo.width} height={photo.height}
              blurhash={photo.blurhash} fit="cover"
              loading={priority ? "eager" : "lazy"} decoding="async"
              class="photo-card-image" {...responsive} />
          </div>
        </a>
        <FavoriteControl
          photoId={photo.id}
          title={photo.title}
          favorited={photo.isFavorited ?? false}
          viewerId={viewerId}
          returnTo={safeReturnTo}
        />
        {owned ? (
          <form data-photo-delete-form="true" data-zfb-reload="" method="post" action="/my-photos" class="photo-delete-form-card">
            <input type="hidden" name="photo_id" value={String(photo.id)} />
            <input type="hidden" name="return_to" value={safeReturnTo} />
            <button type="submit" class="photo-delete-action" aria-label={`Delete ${photo.title}`} data-photo-title={photo.title}>
              <DeleteIcon />
            </button>
          </form>
        ) : null}
        {owned && selectable ? (
          <label class="photo-select-action">
            <input data-photo-select="true" type="checkbox" name="photo_id" value={String(photo.id)} form="photo-bulk-delete-form" aria-label={`Select ${photo.title}`} />
          </label>
        ) : null}
      </div>
      <h3 class="photo-card-title">
        <a href={`/photos/${photo.id}`} class="photo-card-link">{photo.title}</a>
      </h3>
    </li>
  );
}
