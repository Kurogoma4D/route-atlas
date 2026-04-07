/**
 * Framework Detection Engine
 *
 * Parses a repository's package.json to detect the frontend framework
 * and returns the corresponding routing file patterns.
 *
 * Supported frameworks (per SPEC.md §5.2):
 * - Next.js (App Router / Pages Router)
 * - Nuxt
 * - Angular
 * - React Router
 * - Vue Router
 * - Remix
 * - SvelteKit
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
  | "plain-html";

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
    (f) => f.endsWith(".html") && !EXCLUDED_DIR_PREFIXES.some((p) => f.startsWith(p)),
  );
  if (hasHtmlFiles) {
    return {
      framework: "plain-html",
      routingFilePatterns: ["**/*.html"],
    };
  }

  throw new UnsupportedFrameworkError();
}
