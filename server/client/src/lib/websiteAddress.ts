/**
 * A site's address as something a person can open, or null.
 *
 * A hosted site made before the hosting domain was set up carries a
 * placeholder under `.invalid`, which is reserved never to resolve (RFC 2606;
 * `hostedPublicUrl` on the server). A link to it is a dead link presented as
 * somebody's website, so a screen shows nothing in its place instead.
 */
export function reachableAddress(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.endsWith(".invalid") ? null : url;
  } catch {
    return null;
  }
}
