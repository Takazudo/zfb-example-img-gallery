import { Island } from "@takazudo/zfb";
import { ClientRouter } from "@takazudo/zfb-runtime";
import type { ComponentChildren, FunctionComponent } from "preact";
import { DisplaySettings } from "../components/display-settings";
import {
  CameraIcon,
  ChevronDownIcon,
  CircleUserIcon,
  ImagesIcon,
  LayoutGridIcon,
  LogInIcon,
  LogOutIcon,
  MenuIcon,
  SettingsIcon,
  StarIcon,
  TagsIcon,
  UploadIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "../components/icons";
import { InfiniteGalleryControllerIsland } from "../components/infinite-gallery-controller";
import { FaviconLinks, Seo } from "../components/seo";
import { ThemeToggle } from "../components/theme-toggle";
import { GALLERY_PREFERENCES_BOOTSTRAP_SCRIPT } from "../lib/gallery-preferences";
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
const DOCUMENT_BOOTSTRAP_SCRIPT = `${THEME_BOOTSTRAP_SCRIPT}${GALLERY_PREFERENCES_BOOTSTRAP_SCRIPT}`;
const focusClass = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const navLinkClass = `inline-flex min-h-[2.75rem] items-center gap-[0.45rem] rounded-md px-hsp-sm text-small font-medium text-ink-soft transition-colors hover:bg-surface-sunken hover:text-ink aria-[current=page]:bg-surface-sunken aria-[current=page]:text-ink ${focusClass}`;
const iconButtonClass = `group relative inline-flex min-h-[2.75rem] min-w-[2.75rem] items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-surface-sunken hover:text-ink ${focusClass}`;
const tooltipClass = "pointer-events-none absolute left-1/2 top-full z-30 mt-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-ink px-hsp-xs py-hsp-2xs text-micro font-medium text-paper opacity-0 transition-opacity delay-200 [.group:hover_&]:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100";
const menuRowClass = `flex w-full min-h-[2.75rem] items-center gap-hsp-sm rounded-md px-hsp-sm text-left text-small text-ink transition-colors hover:bg-surface-sunken aria-[current=page]:bg-surface-sunken aria-[current=page]:font-semibold ${focusClass}`;

type NavLinkProps = {
  href: string;
  activePath?: string;
  children: ComponentChildren;
  Icon: FunctionComponent<{ class?: string }>;
  variant: "section" | "compact";
  autoFocus?: boolean;
};

function NavLink({ href, activePath, children, Icon, variant, autoFocus }: NavLinkProps) {
  const variantClass = variant === "section"
    ? "max-md:w-full max-md:min-h-12"
    : "group relative max-md:min-w-[2.75rem] max-md:justify-center max-md:px-0";

  return (
    <a
      href={href}
      aria-current={activePath === href ? "page" : undefined}
      class={`${navLinkClass} ${variantClass}`}
      autoFocus={autoFocus}
    >
      <Icon class="size-[1.125rem]" />
      <span class={variant === "compact" ? "sr-only md:not-sr-only" : undefined}>{children}</span>
      {variant === "compact" ? (
        <span aria-hidden="true" class={`${tooltipClass} md:hidden`}>{children}</span>
      ) : null}
    </a>
  );
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
          dangerouslySetInnerHTML={{ __html: DOCUMENT_BOOTSTRAP_SCRIPT }}
        />
        {ClientRouter({
          fallback: "animate",
          preserveHtmlAttrs: ["data-theme", "data-thumb-ratio", "data-thumb-width"],
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
          {(
            <Island when="load">
              <InfiniteGalleryControllerIsland />
            </Island>
          ) as unknown as ComponentChildren}
          <header class="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
            <div class="flex w-full flex-wrap items-center gap-hsp-2xs min-h-[3.75rem] px-gutter py-vsp-2xs md:gap-hsp-md">
              <a href="/" class={`inline-flex min-h-[2.75rem] items-center gap-hsp-xs text-heading font-semibold tracking-tight ${focusClass}`}>
                <LayoutGridIcon class="size-5" />
                {SITE_NAME}
              </a>
              <nav aria-label="Primary" class="flex min-w-0 flex-1 items-center justify-end gap-hsp-2xs">
                <div
                  id="primary-menu"
                  popover
                  class="fixed inset-0 m-0 h-dvh w-full max-w-none border-0 bg-transparent p-0 open:block md:contents"
                >
                  <button
                    type="button"
                    popovertarget="primary-menu"
                    popovertargetaction="hide"
                    aria-label="Close menu"
                    class="absolute inset-0 h-full w-full cursor-default bg-ink/40 md:hidden"
                  />
                  <div class="absolute inset-y-0 right-0 flex w-[min(20rem,85vw)] flex-col gap-vsp-2xs overflow-y-auto overscroll-contain border-l border-line bg-surface p-hsp-sm text-ink shadow-raised md:contents">
                    <div class="flex items-center justify-between pb-vsp-xs pl-hsp-sm font-semibold md:hidden">
                      Menu
                      <button
                        type="button"
                        popovertarget="primary-menu"
                        popovertargetaction="hide"
                        aria-label="Close"
                        class={iconButtonClass}
                      >
                        <XIcon class="size-5" />
                        <span aria-hidden="true" class={tooltipClass}>Close</span>
                      </button>
                    </div>
                    <NavLink variant="section" href="/" activePath={activePath} Icon={ImagesIcon} autoFocus>Gallery</NavLink>
                    <NavLink variant="section" href="/authors" activePath={activePath} Icon={UsersIcon}>Authors</NavLink>
                    <NavLink variant="section" href="/tags" activePath={activePath} Icon={TagsIcon}>Tags</NavLink>
                    <span class="hidden flex-1 md:block" />
                    {(
                      <Island when="load">
                        <DisplaySettings />
                      </Island>
                    ) as unknown as ComponentChildren}
                  </div>
                </div>
                {(
                  <Island when="load">
                    <ThemeToggle />
                  </Island>
                ) as unknown as ComponentChildren}
                <span aria-hidden="true" class="mx-hsp-2xs hidden h-6 w-px bg-line md:block" />
                {user ? (
                  <>
                    <a
                      href="/upload"
                      class={`group relative inline-flex min-h-[2.75rem] items-center justify-center gap-[0.45rem] rounded-md bg-brand px-hsp-md text-small font-semibold text-on-brand transition-colors hover:bg-brand-strong max-md:min-w-[2.75rem] max-md:px-0 ${focusClass}`}
                    >
                      <UploadIcon class="size-5" />
                      <span class="sr-only md:not-sr-only">Upload</span>
                      <span aria-hidden="true" class={`${tooltipClass} md:hidden`}>Upload</span>
                    </a>
                    <button
                      type="button"
                      popovertarget="account-menu"
                      aria-label="Account menu"
                      class={`group relative inline-flex min-h-[2.75rem] min-w-[2.75rem] items-center gap-hsp-xs rounded-md px-hsp-xs text-small font-medium text-ink-soft transition-colors hover:bg-surface-sunken hover:text-ink ${focusClass}`}
                    >
                      {user.avatarKey ? (
                        <img src={`/img/${user.avatarKey}`} alt="" width={28} height={28} class="size-7 rounded-pill object-cover" />
                      ) : (
                        <span class="inline-flex size-7 items-center justify-center rounded-pill bg-surface-sunken text-micro font-semibold text-ink">
                          {user.username.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span class="hidden max-w-40 truncate lg:inline">@{user.username}</span>
                      <ChevronDownIcon class="size-3.5" />
                      <span aria-hidden="true" class={`${tooltipClass} lg:hidden`}>@{user.username}</span>
                    </button>
                    <div
                      id="account-menu"
                      popover
                      class="fixed inset-auto top-[4.125rem] right-gutter m-0 min-w-56 rounded-lg border border-line-strong bg-surface p-vsp-2xs text-ink shadow-raised open:block"
                    >
                      <div class="px-hsp-sm pb-vsp-2xs pt-vsp-xs text-micro text-ink-soft">Signed in as</div>
                      <a
                        href={`/authors/${user.username}`}
                        aria-current={activePath === `/authors/${user.username}` ? "page" : undefined}
                        class={menuRowClass}
                      >
                        <CircleUserIcon class="size-[1.125rem] text-ink-soft" />
                        <span class="min-w-0">
                          <span class="block truncate">@{user.username}</span>
                          <span class="block text-micro text-ink-soft">View profile</span>
                        </span>
                      </a>
                      <a href="/my-photos" aria-current={activePath === "/my-photos" ? "page" : undefined} class={menuRowClass}>
                        <CameraIcon class="size-[1.125rem] text-ink-soft" />
                        My Photos
                      </a>
                      <a href="/favorites" aria-current={activePath === "/favorites" ? "page" : undefined} class={menuRowClass}>
                        <StarIcon class="size-[1.125rem] text-ink-soft" />
                        Favorites
                      </a>
                      <a href="/settings" aria-current={activePath === "/settings" ? "page" : undefined} class={menuRowClass}>
                        <SettingsIcon class="size-[1.125rem] text-ink-soft" />
                        Settings
                      </a>
                      <hr class="my-vsp-2xs border-line" />
                      <form method="post" action="/logout">
                        <button type="submit" class={`${menuRowClass} cursor-pointer`}>
                          <LogOutIcon class="size-[1.125rem] text-ink-soft" />
                          Sign out
                        </button>
                      </form>
                    </div>
                  </>
                ) : (
                  <>
                    <NavLink variant="compact" href="/login" activePath={activePath} Icon={LogInIcon}>Sign in</NavLink>
                    <a
                      href="/register"
                      aria-current={activePath === "/register" ? "page" : undefined}
                      class={`group relative inline-flex min-h-[2.75rem] items-center gap-[0.45rem] rounded-md border border-line-strong px-hsp-sm text-small font-semibold text-ink transition-colors hover:bg-surface-sunken max-md:min-w-[2.75rem] max-md:justify-center max-md:px-0 aria-[current=page]:bg-surface-sunken ${focusClass}`}
                    >
                      <UserPlusIcon class="size-5" />
                      <span class="sr-only md:not-sr-only">Register</span>
                      <span aria-hidden="true" class={`${tooltipClass} md:hidden`}>Register</span>
                    </a>
                  </>
                )}
                <button
                  type="button"
                  popovertarget="primary-menu"
                  aria-label="Menu"
                  class={`${iconButtonClass} md:hidden`}
                >
                  <MenuIcon class="size-5" />
                  <span aria-hidden="true" class={tooltipClass}>Menu</span>
                </button>
              </nav>
            </div>
          </header>
          <main class="w-full flex-1 px-gutter py-vsp-lg">{children}</main>
          <footer class="border-t border-line bg-surface-sunken">
            <div class="px-gutter py-vsp-md text-micro text-ink-soft">
              <p>{SITE_NAME}. {TAGLINE} Built with <a class="underline hover:text-ink" href="https://github.com/Takazudo/zudo-front-builder">zudo-front-builder</a>.</p>
            </div>
          </footer>
      </body>
    </html>
  );
}
