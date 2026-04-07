/**
 * Production environment configuration.
 *
 * In production on Cloudflare Pages, /api/* requests are proxied to the
 * backend Workers service via _routes.json, so apiBaseUrl is empty.
 * Override via fileReplacements in angular.json if a different base is needed.
 */
export const environment = {
  production: true,
  apiBaseUrl: "",
};
