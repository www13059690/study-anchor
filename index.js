/**
 * Host half of study-anchor.
 *
 * There is nothing to do on the Host: selection capture, the anchor registry,
 * the dashed-underline annotation layer, and concept-session creation all run
 * in the browser half, which reaches the Host through the shipped Client
 * services (`ctx.sessions` / `ctx.uiWorkspace`).
 *
 * This row exists only so the bundle is loadable — the Client module is
 * resolved from `dsh.client` on this package through the Host row below it.
 */
export function apply() {}
