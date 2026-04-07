/**
 * Framework Detection Engine
 *
 * Detects the project platform (web / android / ios / flutter) and then the
 * specific framework or navigation library in use. Returns the corresponding
 * routing file patterns so the analysis pipeline knows which files to
 * feed to the LLM.
 *
 * Supported frameworks:
 * - Next.js (App Router / Pages Router)
 * - Nuxt
 * - Gatsby
 * - Angular
 * - React Router
 * - Vue Router
 * - Remix
 * - SvelteKit
 * - Plain HTML
 * - Android Navigation Component
 * - Android Compose Navigation
 * - iOS SwiftUI
 * - iOS UIKit
 * - Flutter go_router
 * - Flutter auto_route
 * - Flutter Navigator (imperative)
 * - TanStack Router
 * - Astro
 * - SolidStart
 * - Qwik City
 * - Expo Router (React Native)
 * - React Navigation (React Native)
 */

import yaml from "js-yaml";
import { EXCLUDED_DIR_PREFIXES } from "./constants.js";

export type FrameworkName =
  | "nextjs-app"
  | "nextjs-pages"
  | "nuxt"
  | "angular"
  | "tanstack-router"
  | "react-router"
  | "vue-router"
  | "remix"
  | "sveltekit"
  | "plain-html"
  | "android-navigation"
  | "android-compose-navigation"
  | "ios-swiftui"
  | "ios-uikit"
  | "flutter-go-router"
  | "flutter-auto-route"
  | "flutter-navigator"
  | "gatsby"
  | "astro"
  | "solid-start"
  | "expo-router"
  | "react-navigation"
  | "qwik-city";

export interface FrameworkDetectionResult {
  framework: FrameworkName;
  routingFilePatterns: string[];
}

export class UnsupportedFrameworkError extends Error {
  constructor(message?: string) {
    super(message ?? "No supported frontend framework or HTML files detected");
    this.name = "UnsupportedFrameworkError";
  }
}

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * The platform type determined by project structure files.
 */
export type PlatformType = "web" | "android" | "ios" | "flutter";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the framework name refers to an Android navigation variant.
 */
export function isAndroidFramework(framework: string): boolean {
  return (
    framework === "android-navigation" ||
    framework === "android-compose-navigation"
  );
}

/**
 * Returns true when the framework name refers to an iOS framework variant.
 */
export function isIOSFramework(framework: string): boolean {
  return framework === "ios-swiftui" || framework === "ios-uikit";
}

/**
 * Returns true when the framework name refers to a Flutter framework variant.
 */
export function isFlutterFramework(framework: string): boolean {
  return (
    framework === "flutter-go-router" ||
    framework === "flutter-auto-route" ||
    framework === "flutter-navigator"
  );
}

/**
 * Returns true when the framework name refers to a React Native framework variant.
 */
export function isReactNativeFramework(framework: string): boolean {
  return framework === "expo-router" || framework === "react-navigation";
}

/**
 * Returns true when the framework name refers to an Astro framework.
 */
export function isAstroFramework(framework: string): boolean {
  return framework === "astro";
}

/**
 * Returns true when the file path starts with any excluded directory prefix.
 */
export function isExcludedPath(f: string): boolean {
  return EXCLUDED_DIR_PREFIXES.some((p) => f.startsWith(p));
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/**
 * Detect the project platform based on the file tree.
 *
 * - If any Gradle build files or AndroidManifest.xml are found, the project
 *   is classified as "android".
 * - Otherwise, it falls back to "web".
 *
 * Gradle files are matched at the root level as well as in subdirectories
 * (e.g. `app/build.gradle.kts`) to support multi-module Android projects,
 * while still excluding paths under EXCLUDED_DIR_PREFIXES.
 */
export function detectPlatform(fileTree: string[]): PlatformType {
  // React Native / Expo detection — check EARLY, before Flutter, Android, and
  // iOS checks. RN projects contain `android/` and/or `ios/` directories
  // alongside a `package.json`. Native Android projects never have a
  // package.json at root, and native iOS projects don't either, so the
  // coexistence of package.json with these directories is a strong signal of
  // a cross-platform JS framework (RN/Expo). Return "web" so that the
  // package.json-based framework detection path runs.
  const hasPackageJson = fileTree.some((f) => f === "package.json");
  const hasAndroidDir = fileTree.some(
    (f) => f === "android" || f.startsWith("android/"),
  );
  const hasIOSDir = fileTree.some((f) => f === "ios" || f.startsWith("ios/"));
  if (hasPackageJson && (hasAndroidDir || hasIOSDir)) {
    return "web";
  }

  // Flutter detection — check for pubspec.yaml before Android because Flutter
  // projects often contain Gradle build files for Android host apps.
  // Require a secondary indicator (android/, ios/, or lib/main.dart) to
  // distinguish Flutter from pure Dart server projects (dart_frog, shelf).
  const hasPubspec = fileTree.some((f) => f === "pubspec.yaml");
  const hasFlutterIndicator = fileTree.some(
    (f) =>
      f === "android" ||
      f.startsWith("android/") ||
      f === "ios" ||
      f.startsWith("ios/") ||
      f === "lib/main.dart",
  );
  if (hasPubspec && hasFlutterIndicator) {
    return "flutter";
  }

  const rootIndicators = [
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
  ];

  const hasGradleRoot = fileTree.some((f) => rootIndicators.includes(f));
  const hasGradleAnywhere = fileTree.some(
    (f) =>
      (f.endsWith("/build.gradle") || f.endsWith("/build.gradle.kts")) &&
      !isExcludedPath(f),
  );
  const hasManifest = fileTree.some(
    (f) => f.endsWith("AndroidManifest.xml") && !isExcludedPath(f),
  );

  if (hasGradleRoot || hasGradleAnywhere || hasManifest) {
    return "android";
  }

  // iOS detection: look for Xcode project files or Podfile.
  // Package.swift alone is not a reliable iOS indicator (server-side Swift
  // projects like Vapor also have it), so it is only used as a supporting
  // signal when combined with other iOS indicators.
  const hasXcodeproj = fileTree.some(
    (f) => f.endsWith(".xcodeproj/project.pbxproj") && !isExcludedPath(f),
  );
  const hasXcworkspace = fileTree.some(
    (f) =>
      f.endsWith(".xcworkspace/contents.xcworkspacedata") && !isExcludedPath(f),
  );
  const hasPodfile = fileTree.some((f) => f === "Podfile");

  const hasIOSIndicator = hasXcodeproj || hasXcworkspace || hasPodfile;

  if (hasIOSIndicator) {
    return "ios";
  }

  return "web";
}

// ---------------------------------------------------------------------------
// Android framework detection
// ---------------------------------------------------------------------------

/**
 * Routing file patterns for Android Navigation Component (XML-based).
 */
const ANDROID_NAVIGATION_PATTERNS = [
  "**/res/navigation/*.xml",
  "**/AndroidManifest.xml",
  "**/*Activity.kt",
  "**/*Activity.java",
  "**/*Fragment.kt",
  "**/*Fragment.java",
];

/**
 * Routing file patterns for Jetpack Compose Navigation.
 */
const ANDROID_COMPOSE_NAVIGATION_PATTERNS = [
  "**/res/navigation/*.xml",
  "**/AndroidManifest.xml",
  "**/*Activity.kt",
  "**/*Activity.java",
  "**/*Fragment.kt",
  "**/*Fragment.java",
  "**/*NavGraph.kt",
  "**/*Navigation.kt",
  "**/*Screen.kt",
];

/**
 * Detect the Android navigation framework from the contents of Gradle build
 * files found in the repository.
 *
 * @param buildFileContents - Array of objects containing the path and content
 *   of Gradle build files (build.gradle / build.gradle.kts).
 * @returns The detected Android framework and its routing file patterns.
 */
export function detectAndroidFramework(
  buildFileContents: { path: string; content: string }[],
): FrameworkDetectionResult {
  const allContent = buildFileContents.map((f) => f.content).join("\n");

  // Check for Compose Navigation first (more specific)
  if (
    allContent.includes("androidx.navigation.compose") ||
    allContent.includes("navigation-compose")
  ) {
    return {
      framework: "android-compose-navigation",
      routingFilePatterns: ANDROID_COMPOSE_NAVIGATION_PATTERNS,
    };
  }

  // Check for standard Navigation Component (XML-based)
  if (
    allContent.includes("navigation-fragment") ||
    allContent.includes("navigation-ui")
  ) {
    return {
      framework: "android-navigation",
      routingFilePatterns: ANDROID_NAVIGATION_PATTERNS,
    };
  }

  // Fallback: generic Android project with navigation patterns
  return {
    framework: "android-navigation",
    routingFilePatterns: ANDROID_NAVIGATION_PATTERNS,
  };
}

// ---------------------------------------------------------------------------
// iOS framework detection
// ---------------------------------------------------------------------------

/**
 * Routing file patterns for iOS SwiftUI projects.
 */
const IOS_SWIFTUI_PATTERNS = [
  "**/*View.swift",
  "**/*App.swift",
  "**/*NavigationView.swift",
  "**/*Coordinator.swift",
  "**/*Router.swift",
  "**/*Wireframe.swift",
];

/**
 * Routing file patterns for iOS UIKit projects.
 */
const IOS_UIKIT_PATTERNS = [
  "**/*.storyboard",
  "**/*ViewController.swift",
  "**/*ViewController.m",
  "**/*Coordinator.swift",
  "**/*Router.swift",
  "**/*Wireframe.swift",
  "**/*View.swift",
  "**/*App.swift",
  "**/*NavigationView.swift",
];

/**
 * Detect the iOS UI framework from Swift source file contents found in
 * the repository.
 *
 * @param sourceFileContents - Array of objects containing the path and content
 *   of Swift source files.
 * @param fileTree - The full file tree used for storyboard detection.
 * @returns The detected iOS framework and its routing file patterns.
 */
export function detectiOSFramework(
  sourceFileContents: { path: string; content: string }[],
  fileTree: string[],
): FrameworkDetectionResult {
  const swiftContents = sourceFileContents
    .filter((f) => f.path.endsWith(".swift"))
    .map((f) => f.content);
  const allSwiftContent = swiftContents.join("\n");

  // Also scan Objective-C files (.m, .h) for UIKit patterns
  const objcContents = sourceFileContents
    .filter((f) => f.path.endsWith(".m") || f.path.endsWith(".h"))
    .map((f) => f.content);
  const allObjcContent = objcContents.join("\n");

  // Check for SwiftUI navigation patterns
  const hasSwiftUIImport = allSwiftContent.includes("import SwiftUI");
  const hasSwiftUINavigation =
    allSwiftContent.includes("NavigationStack") ||
    allSwiftContent.includes("NavigationView") ||
    allSwiftContent.includes("NavigationSplitView");

  if (hasSwiftUIImport && hasSwiftUINavigation) {
    return {
      framework: "ios-swiftui",
      routingFilePatterns: IOS_SWIFTUI_PATTERNS,
    };
  }

  // Check for UIKit patterns: storyboard files or UIViewController subclasses
  // in both Swift and Objective-C sources
  const hasStoryboard = fileTree.some(
    (f) => f.endsWith(".storyboard") && !isExcludedPath(f),
  );
  const hasUIViewController =
    allSwiftContent.includes("UIViewController") ||
    allObjcContent.includes("UIViewController");

  if (hasStoryboard || hasUIViewController) {
    return {
      framework: "ios-uikit",
      routingFilePatterns: IOS_UIKIT_PATTERNS,
    };
  }

  // Fallback: generic iOS project — default to SwiftUI (modern default)
  return {
    framework: "ios-swiftui",
    routingFilePatterns: IOS_SWIFTUI_PATTERNS,
  };
}

// ---------------------------------------------------------------------------
// Flutter framework detection
// ---------------------------------------------------------------------------

/**
 * Routing file patterns for Flutter go_router projects.
 */
const FLUTTER_GO_ROUTER_PATTERNS = [
  "lib/**/router.dart",
  "lib/**/routes.dart",
  "lib/**/*_router.dart",
];

/**
 * Routing file patterns for Flutter auto_route projects.
 */
const FLUTTER_AUTO_ROUTE_PATTERNS = [
  "lib/**/*_router.dart",
  "lib/**/*_router.gr.dart",
];

/**
 * Routing file patterns for Flutter Navigator (imperative) projects.
 */
const FLUTTER_NAVIGATOR_PATTERNS = [
  "lib/**/main.dart",
  "lib/**/app.dart",
  "lib/**/*.dart",
];

/**
 * Minimal representation of the pubspec.yaml dependencies section.
 */
export interface PubspecYaml {
  dependencies?: Record<string, unknown>;
  dev_dependencies?: Record<string, unknown>;
}

/**
 * Detect the Flutter routing framework from the contents of pubspec.yaml.
 *
 * @param pubspecContent - The raw YAML string of pubspec.yaml.
 * @returns The detected Flutter framework and its routing file patterns.
 */
export function detectFlutterFramework(
  pubspecContent: string,
): FrameworkDetectionResult {
  let pubspec: PubspecYaml;
  try {
    pubspec =
      (yaml.load(pubspecContent, {
        schema: yaml.JSON_SCHEMA,
      }) as PubspecYaml) ?? {};
  } catch {
    // If YAML parsing fails, fall back to Navigator
    return {
      framework: "flutter-navigator",
      routingFilePatterns: FLUTTER_NAVIGATOR_PATTERNS,
    };
  }

  const deps = pubspec.dependencies ?? {};
  const devDeps = pubspec.dev_dependencies ?? {};
  const allDepKeys = new Set([...Object.keys(deps), ...Object.keys(devDeps)]);

  // Check for go_router first (most popular)
  if (allDepKeys.has("go_router")) {
    return {
      framework: "flutter-go-router",
      routingFilePatterns: FLUTTER_GO_ROUTER_PATTERNS,
    };
  }

  // Check for auto_route
  if (allDepKeys.has("auto_route")) {
    return {
      framework: "flutter-auto-route",
      routingFilePatterns: FLUTTER_AUTO_ROUTE_PATTERNS,
    };
  }

  // Fallback: Flutter Navigator (imperative)
  return {
    framework: "flutter-navigator",
    routingFilePatterns: FLUTTER_NAVIGATOR_PATTERNS,
  };
}

// ---------------------------------------------------------------------------
// Web framework detection (existing logic)
// ---------------------------------------------------------------------------

/**
 * Frameworks are listed in priority order. When multiple framework
 * dependency keys appear in the same package.json, the first match wins.
 *
 * Meta-frameworks (Next.js, Nuxt, Remix, SvelteKit) are checked before
 * library-level routers (React Router, Vue Router) because a project
 * using Next.js will also often have react-router-dom in its deps.
 */
interface FrameworkRule {
  key: string;
  resolve: (fileTree: string[]) => FrameworkDetectionResult;
}

/**
 * Shared routing file patterns for React Navigation (used by both the
 * explicit `@react-navigation/native` rule and the `react-native` fallback).
 */
const REACT_NAVIGATION_PATTERNS: string[] = [
  "src/**/navigation/*.{tsx,jsx,ts,js}",
  "src/**/*Navigator.{tsx,jsx,ts,js}",
  "src/**/*Screen.{tsx,jsx,ts,js}",
];

const FRAMEWORK_RULES: FrameworkRule[] = [
  // React Native frameworks — checked before web frameworks because RN
  // projects may also have react-router-dom or other web dependencies.
  {
    key: "expo-router",
    resolve: () => ({
      framework: "expo-router",
      routingFilePatterns: [
        "app/**/_layout.{tsx,jsx,ts,js}",
        "app/**/index.{tsx,jsx,ts,js}",
        // Expo Router convention: every file under app/ is a route (except
        // _-prefixed files other than _layout). The catch-all is intentionally
        // broad to match dynamic routes like [id].tsx and named routes.
        "app/**/*.{tsx,jsx,ts,js}",
      ],
    }),
  },
  {
    key: "@react-navigation/native",
    resolve: () => ({
      framework: "react-navigation",
      routingFilePatterns: REACT_NAVIGATION_PATTERNS,
    }),
  },
  {
    key: "react-native",
    resolve: () => ({
      framework: "react-navigation",
      routingFilePatterns: REACT_NAVIGATION_PATTERNS,
    }),
  },
  // Web frameworks
  {
    key: "next",
    resolve: (fileTree) => resolveNextJs(fileTree),
  },
  {
    key: "nuxt",
    resolve: () => ({
      framework: "nuxt",
      routingFilePatterns: ["pages/**/*.vue"],
    }),
  },
  {
    key: "gatsby",
    resolve: () => ({
      framework: "gatsby",
      routingFilePatterns: ["src/pages/**/*.{tsx,jsx,ts,js}"],
    }),
  },
  {
    key: "astro",
    resolve: () => ({
      framework: "astro",
      routingFilePatterns: ["src/pages/**/*.{astro,tsx,jsx,ts,js,md,mdx}"],
    }),
  },
  {
    key: "@angular/core",
    resolve: () => ({
      framework: "angular",
      routingFilePatterns: ["**/*-routing.module.ts", "**/app.routes.ts"],
    }),
  },
  {
    key: "@remix-run/react",
    resolve: () => ({
      framework: "remix",
      routingFilePatterns: ["app/routes/**/*"],
    }),
  },
  {
    key: "@sveltejs/kit",
    resolve: () => ({
      framework: "sveltekit",
      routingFilePatterns: ["src/routes/**/+page.svelte"],
    }),
  },
  {
    key: "@solidjs/start",
    resolve: () => ({
      framework: "solid-start" as const,
      routingFilePatterns: ["src/routes/**/*.{tsx,jsx,ts,js}"],
    }),
  },
  {
    key: "solid-start",
    resolve: () => ({
      framework: "solid-start" as const,
      routingFilePatterns: ["src/routes/**/*.{tsx,jsx,ts,js}"],
    }),
  },
  {
    key: "@builder.io/qwik-city",
    resolve: () => ({
      framework: "qwik-city" as const,
      routingFilePatterns: [
        "src/routes/**/index.{tsx,jsx,ts,js}",
        "src/routes/**/layout.{tsx,jsx,ts,js}",
      ],
    }),
  },
  {
    key: "@tanstack/react-router",
    resolve: () => ({
      framework: "tanstack-router" as const,
      routingFilePatterns: [
        "src/routes/**/*.{tsx,jsx,ts,js}",
        "src/**/routeTree.gen.ts",
        "src/**/router.{tsx,jsx,ts,js}",
      ],
    }),
  },
  {
    key: "react-router-dom",
    resolve: () => ({
      framework: "react-router",
      routingFilePatterns: [
        "src/**/routes.{tsx,jsx,ts,js}",
        "src/**/router.{tsx,jsx,ts,js}",
        "src/**/*.routes.{tsx,jsx,ts,js}",
      ],
    }),
  },
  {
    key: "vue-router",
    resolve: () => ({
      framework: "vue-router",
      routingFilePatterns: ["router/index.{ts,js}"],
    }),
  },
];

/**
 * Resolve Next.js to App Router or Pages Router based on the file tree.
 * If both `app/` and `pages/` directories exist, App Router takes priority
 * because it is the newer recommended approach.
 */
function resolveNextJs(fileTree: string[]): FrameworkDetectionResult {
  const hasAppDir = fileTree.some(
    (f) =>
      f === "app" ||
      f.startsWith("app/") ||
      f === "src/app" ||
      f.startsWith("src/app/"),
  );
  const hasPagesDir = fileTree.some(
    (f) =>
      f === "pages" ||
      f.startsWith("pages/") ||
      f === "src/pages" ||
      f.startsWith("src/pages/"),
  );

  if (hasAppDir) {
    return {
      framework: "nextjs-app",
      routingFilePatterns: [
        "app/**/page.{tsx,jsx,ts,js}",
        "app/**/layout.*",
        "src/app/**/page.{tsx,jsx,ts,js}",
        "src/app/**/layout.*",
      ],
    };
  }

  if (hasPagesDir) {
    return {
      framework: "nextjs-pages",
      routingFilePatterns: [
        "pages/**/*.{tsx,jsx,ts,js}",
        "src/pages/**/*.{tsx,jsx,ts,js}",
      ],
    };
  }

  // Default to App Router when directory structure is unknown
  return {
    framework: "nextjs-app",
    routingFilePatterns: [
      "app/**/page.{tsx,jsx,ts,js}",
      "app/**/layout.*",
      "src/app/**/page.{tsx,jsx,ts,js}",
      "src/app/**/layout.*",
    ],
  };
}

/**
 * Collect all dependency keys from both `dependencies` and `devDependencies`.
 */
function getAllDependencyKeys(packageJson: PackageJson): Set<string> {
  const keys = new Set<string>();
  if (packageJson.dependencies) {
    for (const key of Object.keys(packageJson.dependencies)) {
      keys.add(key);
    }
  }
  if (packageJson.devDependencies) {
    for (const key of Object.keys(packageJson.devDependencies)) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Detect the frontend framework from a parsed package.json object.
 *
 * @param packageJson - The parsed contents of a repository's package.json
 * @param fileTree - A list of file/directory paths in the repository root
 *                   (used to distinguish Next.js App Router vs Pages Router)
 * @returns The detected framework and its routing file patterns
 * @throws {UnsupportedFrameworkError} If no supported framework is found
 */
export function detectFramework(
  packageJson: PackageJson,
  fileTree: string[] = [],
): FrameworkDetectionResult {
  const depKeys = getAllDependencyKeys(packageJson);

  for (const rule of FRAMEWORK_RULES) {
    if (depKeys.has(rule.key)) {
      return rule.resolve(fileTree);
    }
  }

  // Fallback: detect plain HTML sites when .html files exist in the tree
  const hasHtmlFiles = fileTree.some(
    (f) => f.endsWith(".html") && !isExcludedPath(f),
  );
  if (hasHtmlFiles) {
    return {
      framework: "plain-html",
      routingFilePatterns: ["**/*.html"],
    };
  }

  throw new UnsupportedFrameworkError();
}
