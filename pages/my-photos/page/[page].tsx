import { renderMyPhotosPage } from "../../my-photos";

export const prerender = false;

export default function MyPhotosPagedPage({
  params,
}: { params: { page: string } }): Promise<Response> {
  return renderMyPhotosPage(params.page);
}
