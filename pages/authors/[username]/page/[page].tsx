import { renderAuthorDetail } from "../index";

// Reads D1 for every request — never prerendered.
export const prerender = false;

export default function AuthorDetailPagedPage({
  params,
}: { params: { username: string; page: string } }): Promise<Response> {
  return renderAuthorDetail(params.username, params.page);
}
