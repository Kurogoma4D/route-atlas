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
  "app/build/",
  "Pods/",
  "Carthage/",
  ".build/",
  ".dart_tool/",
  ".fvm/",
];

/**
 * File name patterns that should be excluded from Flutter project analysis.
 * Code-generated files are generally noise, except for auto_route's `*.gr.dart`
 * which contains route definitions.
 */
export const FLUTTER_EXCLUDED_FILE_PATTERNS = [
  /\.g\.dart$/,
  /\.freezed\.dart$/,
];
