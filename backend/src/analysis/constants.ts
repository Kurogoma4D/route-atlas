/**
 * Shared constants for the analysis module.
 *
 * Directory prefixes that should be excluded when scanning for source files.
 * Used by both the framework detector (plain-html fallback) and the
 * analysis pipeline (component file filtering).
 */
export const EXCLUDED_DIR_PREFIXES = [
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "out/",
  ".nuxt/",
  ".svelte-kit/",
  "vendor/",
  "public/",
  "static/",
  ".gradle/",
];
