import { Island } from "@takazudo/zfb";
import { ClientRouter } from "@takazudo/zfb-runtime";
import type { ComponentChildren } from "preact";
import { FaviconLinks, Seo } from "../components/seo";
import { ThemeToggle } from "../components/theme-toggle";
import type { SeoData } from "../lib/seo";
import { SITE_NAME } from "../lib/site";
import { THEME_BOOTSTRAP_SCRIPT } from "../lib/theme";
import "../styles/global.css";

/** Minimal structural shape of the signed-in user. Declared locally because auth and shared types belong to sibling tasks. */
export type LayoutUser = { username: string; avatarKey?: string | null };

type Props = {
  title?: string;
  description?: string;
  seo?: SeoData;
  user?: LayoutUser | null;
  activePath?: string;
  /** SSG rewrites its own generated entry; dynamic documents need the stable alias. */
  includeStableClientEntry?: boolean;
  children: ComponentChildren;
};

const TAGLINE = "A zfb image gallery on Cloudflare.";
const navClass = "inline-flex min-h-[2.75rem] items-center px-hsp-xs text-small text-ink-soft transition-colors hover:text-brand";
const actionClass = "inline-flex min-h-[2.75rem] items-center rounded-md bg-brand px-hsp-sm text-small font-semibold text-on-brand transition-colors hover:bg-brand-strong";

function NavLink({ href, activePath, children }: { href: string; activePath?: string; children: ComponentChildren }) {
  return <a href={href} aria-current={activePath === href ? "page" : undefined} class={navClass}>{children}</a>;
}

export default function GalleryLayout({
  title,
  description = TAGLINE,
  seo,
  user = null,
  activePath,
  includeStableClientEntry = true,
  children,
}: Props) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script
          data-theme-bootstrap
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
        {ClientRouter({
          fallback: "animate",
          preserveHtmlAttrs: ["data-theme"],
          traverseRefetch: true,
        }) as unknown as ComponentChildren}
        {seo ? (
          <Seo seo={seo} />
        ) : (
          <>
            <title>{title ? `${title} — ${SITE_NAME}` : SITE_NAME}</title>
            <meta name="description" content={description} />
          </>
        )}
        <FaviconLinks />
        <link rel="stylesheet" href="/assets/app.css" />
        {includeStableClientEntry ? (
          <script type="module" src="/assets/islands.js" />
        ) : null}
      </head>
      <body class="flex min-h-dvh flex-col">
          <header class="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
            <div class="flex w-full items-center justify-between gap-hsp-md px-gutter py-vsp-sm">
              <a href="/" class="text-heading font-semibold tracking-tight">{SITE_NAME}</a>
              <nav aria-label="Primary" class="flex flex-wrap items-center justify-end gap-hsp-2xs">
                {Island({ when: "load", children: <ThemeToggle /> }) as unknown as ComponentChildren}
                <NavLink href="/" activePath={activePath}>Gallery</NavLink>
                <NavLink href="/authors" activePath={activePath}>Authors</NavLink>
                <NavLink href="/tags" activePath={activePath}>Tags</NavLink>
                {user ? <>
                  <a href="/upload" class={actionClass}>Upload</a>
                  <NavLink href="/settings" activePath={activePath}>Settings</NavLink>
                  <a href={`/authors/${user.username}`} class={`${navClass} gap-hsp-xs`}>
                    {user.avatarKey ? (
                      <img src={`/img/${user.avatarKey}`} alt="" width={28} height={28} class="size-7 rounded-pill object-cover" />
                    ) : (
                      <span class="inline-flex size-7 items-center justify-center rounded-pill bg-surface-sunken text-micro font-semibold text-ink">
                        {user.username.charAt(0).toUpperCase()}
                      </span>
                    )}
                    @{user.username}
                  </a>
                  <form method="post" action="/logout">
                    <button type="submit" class={`${navClass} cursor-pointer`}>Sign out</button>
                  </form>
                </> : <>
                  <NavLink href="/login" activePath={activePath}>Sign in</NavLink>
                  <NavLink href="/register" activePath={activePath}>Register</NavLink>
                </>}
              </nav>
            </div>
          </header>
          <main class="w-full flex-1 px-gutter py-vsp-lg">{children}</main>
          <footer class="border-t border-line bg-surface-sunken">
            <div class="px-gutter py-vsp-md text-micro text-ink-soft">
              <p>{SITE_NAME}. {TAGLINE} Built with <a class="underline hover:text-brand" href="https://github.com/Takazudo/zudo-front-builder">zudo-front-builder</a>.</p>
            </div>
          </footer>
      </body>
    </html>
  );
}
