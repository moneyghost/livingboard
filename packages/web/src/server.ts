/** The Livingboard server: the page's own origin, or port 3333 next to the Vite dev server. */
export const SERVER_HOST = import.meta.env.DEV ? `${location.hostname}:3333` : location.host;
export const API = `${location.protocol}//${SERVER_HOST}/api`;
