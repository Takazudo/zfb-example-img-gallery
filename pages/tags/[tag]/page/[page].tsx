import { renderTagDetailRoute, type TagRouteParams, type TagRouteResult } from "../index";

export const prerender = false;

type Props = { params?: TagRouteParams };

export default async function TagDetailPage({ params }: Props = {}): Promise<TagRouteResult> {
  return renderTagDetailRoute(params);
}
