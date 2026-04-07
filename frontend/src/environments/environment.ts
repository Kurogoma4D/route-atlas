/**
 * Development environment configuration.
 *
 * In development, Angular dev server proxies /api/* to the local backend
 * via proxy.conf.json, so apiBaseUrl is empty (relative paths).
 */
export const environment = {
  production: false,
  apiBaseUrl: "",
};
