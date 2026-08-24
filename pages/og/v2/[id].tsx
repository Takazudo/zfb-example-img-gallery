import { generateOgCompositeCard } from "../../../lib/og";
import { createOgRoute } from "../../../lib/og-route";

export const prerender = false;

export default createOgRoute("v2", generateOgCompositeCard);
