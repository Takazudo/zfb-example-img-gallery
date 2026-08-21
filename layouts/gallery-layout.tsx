// PLACEHOLDER — the design-system sub-task replaces this wholesale.
import type { ComponentChildren } from "preact";
import "../styles/global.css";

type Props = {
  title?: string;
  /** Logged-in user, passed as a PROP — this layout must never import auth code. */
  user?: unknown;
  children: ComponentChildren;
};

const SITE_NAME = "zfb Image Gallery";

export default function GalleryLayout({ title, children }: Props) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title ? `${title} | ${SITE_NAME}` : SITE_NAME}</title>
        {/* Stable stylesheet path — see scripts/stable-css.mjs. */}
        <link rel="stylesheet" href="/assets/app.css" />
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
