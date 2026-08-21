import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { Button } from "../components/button";
import { EmptyState } from "../components/empty-state";
import { Field } from "../components/field";
import { Pagination } from "../components/pagination";
import { PhotoCard } from "../components/photo-card";
import { PhotoGrid } from "../components/photo-grid";
import { TagList } from "../components/tag-list";
import { buildPageSeo } from "../lib/seo";
import type { Env } from "../lib/env";
import GalleryLayout from "../layouts/gallery-layout";

export const prerender = false;

const sample = (w: number, h: number, hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<rect width="100%" height="100%" fill="hsl(${hue} 35% 62%)"/></svg>`,
  )}`;

const samplePhotos = [
  { id: 1, title: "5BOX Go-Bako, front", src: sample(2000, 2000, 210), width: 2000, height: 2000 },
  { id: 2, title: "Acrylic sheet, macro", src: sample(2000, 1500, 40), width: 2000, height: 1500 },
  { id: 3, title: "Stand 60x2, side view", src: sample(1125, 1500, 150), width: 1125, height: 1500 },
  { id: 4, title: "Evening workshop", src: sample(2400, 1350, 25), width: 2400, height: 1350 },
  { id: 5, title: "Blue study", src: sample(1600, 1600, 225), width: 1600, height: 1600 },
  { id: 6, title: "Material detail", src: sample(1800, 1350, 75), width: 1800, height: 1350 },
  { id: 7, title: "Vertical assembly", src: sample(1200, 1600, 285), width: 1200, height: 1600 },
  { id: 8, title: "Bench panorama", src: sample(2560, 1440, 185), width: 2560, height: 1440 },
  { id: 9, title: "Orange form", src: sample(1400, 1400, 15), width: 1400, height: 1400 },
  { id: 10, title: "Paper construction", src: sample(2000, 1500, 50), width: 2000, height: 1500 },
  { id: 11, title: "Tall green study", src: sample(1125, 1500, 135), width: 1125, height: 1500 },
  { id: 12, title: "Studio shelf", src: sample(1920, 1080, 330), width: 1920, height: 1080 },
];

export default function HomePage() {
  const { request } = getCloudflareContext<Env>();

  return (
    <GalleryLayout
      title="Gallery"
      activePath="/"
      user={null}
      seo={buildPageSeo({ request, title: "Gallery" })}
    >
      <section class="mb-vsp-lg">
        <p class="text-micro font-semibold uppercase tracking-widest text-brand">Component preview</p>
        <h1 class="mt-vsp-2xs text-display font-semibold tracking-tight">Quiet chrome, loud photographs.</h1>
        <p class="mt-vsp-xs max-w-[42rem] text-body text-ink-soft">A static preview of the shared visual language for Stillframe.</p>
      </section>

      <PhotoGrid>
        {samplePhotos.map((photo, index) => <PhotoCard key={photo.id} photo={photo} priority={index === 0} />)}
      </PhotoGrid>
      <Pagination page={1} pageCount={13} href={(page) => `/page/${page}`} />

      <section class="mt-vsp-xl grid gap-vsp-lg md:grid-cols-2">
        <div class="flex flex-col gap-vsp-sm">
          <h2 class="text-title font-semibold tracking-tight">Tags</h2>
          <TagList size="md" tags={[{ name: "acrylic", count: 18 }, { name: "workshop", count: 9 }, { name: "東京", count: 4 }]} />
          <EmptyState title="Nothing here yet" action={{ href: "/upload", label: "Upload a photo" }}>
            New photographs will appear here after the first upload.
          </EmptyState>
        </div>
        <form method="post" action="#preview" class="flex flex-col gap-vsp-sm rounded-lg border border-line bg-surface p-hsp-md shadow-card">
          <h2 class="text-title font-semibold tracking-tight">Form controls</h2>
          <Field id="preview-title" name="title" label="Title" required hint="Give the photograph a short name." placeholder="Untitled study" />
          <Field id="preview-notes" name="notes" label="Notes" as="textarea" value="Rendered on the server." />
          <div class="flex flex-wrap gap-hsp-xs">
            <Button>Save preview</Button>
            <Button type="button" variant="secondary">Secondary</Button>
            <Button type="button" variant="ghost" size="sm">Ghost</Button>
            <Button type="button" variant="danger" size="sm">Delete</Button>
          </div>
        </form>
      </section>
    </GalleryLayout>
  );
}
