import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { EmptyState } from "../../components/empty-state";
import { buildPageSeo } from "../../lib/seo";
import { authorHref, listAuthorsWithPhotos } from "../../lib/db/authors";
import type { Env } from "../../lib/env";
import { htmlResponse } from "../../lib/render";
import GalleryLayout from "../../layouts/gallery-layout";

// Reads D1 for every request — never prerendered.
export const prerender = false;

function photoCountLabel(count: number): string {
  return `${count} photo${count === 1 ? "" : "s"}`;
}

function authorAvatar(author: { username: string; avatar_key: string | null }) {
  return author.avatar_key ? (
    <img
      src={`/img/${author.avatar_key}`}
      alt=""
      width={64}
      height={64}
      class="size-16 rounded-pill object-cover"
    />
  ) : (
    <span
      aria-hidden="true"
      class="inline-flex size-16 items-center justify-center rounded-pill bg-brand-soft text-heading font-semibold text-brand"
    >
      {author.username.charAt(0).toUpperCase()}
    </span>
  );
}

export default async function AuthorsPage(): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();
  const authors = await listAuthorsWithPhotos(env);

  return htmlResponse(
    <GalleryLayout
      title="Authors"
      activePath="/authors"
      seo={buildPageSeo({
        request,
        title: "Authors",
        description: "Browse the photographers who have shared work in Stillframe.",
        path: "/authors",
      })}
    >
      <section class="mb-vsp-lg">
        <h1 class="text-display font-semibold tracking-tight">Authors</h1>
        <p class="mt-vsp-xs text-body text-ink-soft">Photographers who have shared work here.</p>
      </section>

      {authors.length === 0 ? (
        <EmptyState title="No authors yet" action={{ href: "/register", label: "Create an account" }}>
          Register and share the first photograph in the gallery.
        </EmptyState>
      ) : (
        <ul class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-hsp-md">
          {authors.map((author) => (
            <li key={author.id}>
              <a
                href={authorHref(author.username)}
                class="flex items-center gap-hsp-md rounded-lg border border-line bg-surface p-hsp-md transition-colors hover:border-line-strong"
              >
                {authorAvatar(author)}
                <span class="min-w-0">
                  <span class="block truncate text-heading font-semibold">@{author.username}</span>
                  <span class="mt-vsp-2xs block text-small text-ink-soft">{photoCountLabel(author.photo_count)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </GalleryLayout>,
  );
}
