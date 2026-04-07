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
  ".expo/",
  ".cache/",
  ".gatsby/",
  ".astro/",
  ".solid/",
  ".qwik/",
  "tmp/", // Ember CLI build artifacts
];

/**
 * Additional directory prefixes excluded only when filtering component files
 * for React Native projects. These are kept out of the global list because
 * `detectPlatform` relies on `isExcludedPath` — adding `"android/"` or
 * `"ios/"` globally would prevent Android/iOS platform detection for
 * non-RN projects whose source files live under those directories.
 */
export const REACT_NATIVE_EXCLUDED_DIR_PREFIXES = [
  "android/",
  "ios/",
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
