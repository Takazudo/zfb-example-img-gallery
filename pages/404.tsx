import GalleryLayout from "../layouts/gallery-layout";

// The ONE prerendered page in this repo — deliberately no `prerender = false`.
export const frontmatter = { title: "Not found", description: "Page not found." };

export default function NotFoundPage() {
  return (
    <GalleryLayout title="Not found">
      <h1>404 — not found</h1>
      <p>That page does not exist. <a href="/">Back to the gallery</a>.</p>
    </GalleryLayout>
  );
}
