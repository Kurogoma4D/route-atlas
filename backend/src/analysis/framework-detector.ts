/**
 * Framework Detection Engine
 *
 * Detects the project platform (web / android / ios) and then the specific
 * framework or navigation library in use. Returns the corresponding
 * routing file patterns so the analysis pipeline knows which files to
 * feed to the LLM.
 *
 * Supported frameworks:
 * - Next.js (App Router / Pages Router)
 * - Nuxt
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
 */

import { EXCLUDED_DIR_PREFIXES } from "./constants.js";

export type FrameworkName =
  | "nextjs-app"
  | "nextjs-pages"
  | "nuxt"
  | "angular"
  | "react-router"
  | "vue-router"
  | "remix"
  | "sveltekit"
  | "plain-html"
  | "android-navigation"
  | "android-compose-navigation"
  | "ios-swiftui"
  | "ios-uikit";

export interface FrameworkDetectionResult {
  framework: FrameworkName;
  routingFilePatterns: string[];
}

export class UnsupportedFrameworkError extends Error {
  constructor(message?: string) {
    super(
      message ?? "No supported frontend framework or HTML files detected",
    );
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
export type PlatformType = "web" | "android" | "ios";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the framework name refers to an Android navigation variant.
 */
export function isAndroidFramework(framework: string): boolean {
  return framework === "android-navigation" || framework === "android-compose-navigation";
}

/**
 * Returns true when the framework name refers to an iOS framework variant.
 */
export function isIOSFramework(framework: string): boolean {
  return framework === "ios-swiftui" || framework === "ios-uikit";
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
    (f) => f.endsWith(".xcworkspace/contents.xcworkspacedata") && !isExcludedPath(f),
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
  if (allContent.includes("androidx.navigation.compose") ||
      allContent.includes("navigation-compose")) {
    return {
      framework: "android-compose-navigation",
      routingFilePatterns: ANDROID_COMPOSE_NAVIGATION_PATTERNS,
    };
  }

  // Check for standard Navigation Component (XML-based)
  if (allContent.includes("navigation-fragment") ||
      allContent.includes("navigation-ui")) {
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

const FRAMEWORK_RULES: FrameworkRule[] = [
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
    (f) => f === "app" || f.startsWith("app/") || f === "src/app" || f.startsWith("src/app/"),
  );
  const hasPagesDir = fileTree.some(
    (f) => f === "pages" || f.startsWith("pages/") || f === "src/pages" || f.startsWith("src/pages/"),
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
