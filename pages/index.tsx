import GalleryLayout from "../layouts/gallery-layout";

// Every page in this repo except pages/404.tsx exports this literal.
export const prerender = false;

export default function HomePage() {
  return (
    <GalleryLayout title="Gallery">
      <h1>zfb Image Gallery</h1>
      <p>Scaffold placeholder.</p>
    </GalleryLayout>
  );
}
