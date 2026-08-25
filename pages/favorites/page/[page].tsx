import {
  renderFavoritesRoute,
  type FavoritesRouteParams,
  type FavoritesRouteResult,
} from "../index";

// Reads D1 for every request — never prerendered.
export const prerender = false;

export default function FavoritesPagedPage({
  params,
}: { params?: FavoritesRouteParams } = {}): Promise<FavoritesRouteResult> {
  return renderFavoritesRoute(params?.page);
}
