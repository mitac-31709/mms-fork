/**
 * Permanent redirect from the old Worker hostname to mms-fork.
 * Preserves path and query string.
 */
const TARGET_ORIGIN = "https://mms-fork.mitac31709.workers.dev";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const destination = TARGET_ORIGIN + url.pathname + url.search;
    return Response.redirect(destination, 301);
  },
};
