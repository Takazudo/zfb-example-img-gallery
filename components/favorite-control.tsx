import { loginPath, safeRelativePath } from "../lib/navigation";

export const FAVORITE_STAR_PATH = "M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z";

export function FavoriteStar({ favorited }: { favorited: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      class="size-6"
    >
      <path
        data-favorite-star-path="true"
        d={FAVORITE_STAR_PATH}
        fill={favorited ? "currentColor" : "none"}
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linejoin="round"
      />
    </svg>
  );
}

type Props = {
  photoId: number | string;
  title: string;
  favorited: boolean;
  viewerId?: number | null;
  returnTo: string;
  placement?: "card" | "detail";
};

export function favoriteAccessibleName(title: string, favorited: boolean): string {
  return `${favorited ? "Remove" : "Add"} ${title} ${favorited ? "from" : "to"} favorites`;
}

const sharedClass = "favorite-action";

export function FavoriteControl({
  photoId,
  title,
  favorited,
  viewerId = null,
  returnTo,
  placement = "card",
}: Props) {
  const id = String(photoId);
  const accessibleName = favoriteAccessibleName(title, favorited);
  const colorClass = favorited ? "text-accent" : "text-ink";
  const placementClass = placement === "card" ? "favorite-action-card" : "";
  const className = `${sharedClass} ${colorClass} ${placementClass}`;
  const safeReturnTo = safeRelativePath(returnTo, `/photos/${id}`);

  if (viewerId === null) {
    return (
      <a
        data-favorite-control=""
        data-photo-id={id}
        href={loginPath(safeReturnTo)}
        aria-label={`${accessibleName}; sign in required`}
        class={className}
      >
        <FavoriteStar favorited={false} />
      </a>
    );
  }

  return (
    <form
      data-favorite-control=""
      data-favorite-form=""
      data-zfb-reload=""
      data-photo-id={id}
      method="post"
      action="/favorites"
      class={placementClass}
    >
      <input type="hidden" name="photoId" value={id} />
      <input type="hidden" name="state" value={favorited ? "unfavorited" : "favorited"} />
      <input type="hidden" name="return_to" value={safeReturnTo} />
      <button
        type="submit"
        aria-pressed={favorited}
        aria-label={accessibleName}
        class={`${sharedClass} ${colorClass}`}
      >
        <FavoriteStar favorited={favorited} />
      </button>
    </form>
  );
}
