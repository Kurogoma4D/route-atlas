import { describe, it, expect } from "vitest";
import {
  detectFramework,
  detectPlatform,
  detectAndroidFramework,
  detectiOSFramework,
  detectFlutterFramework,
  isIOSFramework,
  isFlutterFramework,
  isReactNativeFramework,
  isAstroFramework,
  isEmberFramework,
  isExcludedPath,
  UnsupportedFrameworkError,
  type PackageJson,
} from "./framework-detector.js";

// ---------------------------------------------------------------------------
// Helper to build minimal package.json objects
// ---------------------------------------------------------------------------
function pkg(deps: Record<string, string>): PackageJson {
  return { dependencies: deps };
}

function devPkg(devDeps: Record<string, string>): PackageJson {
  return { devDependencies: devDeps };
}

// ---------------------------------------------------------------------------
// 1. Individual framework detection
// ---------------------------------------------------------------------------
describe("detectFramework", () => {
  describe("Next.js (App Router)", () => {
    it("detects Next.js App Router when app/ directory exists", () => {
      const result = detectFramework(pkg({ next: "14.0.0", react: "18.0.0" }), [
        "app/page.tsx",
        "app/layout.tsx",
        "package.json",
      ]);
      expect(result.framework).toBe("nextjs-app");
      expect(result.routingFilePatterns).toContain(
        "app/**/page.{tsx,jsx,ts,js}",
      );
      expect(result.routingFilePatterns).toContain("app/**/layout.*");
    });

    it("detects Next.js App Router when src/app/ directory exists", () => {
      const result = detectFramework(pkg({ next: "14.0.0", react: "18.0.0" }), [
        "src/app/page.tsx",
        "src/app/layout.tsx",
        "package.json",
      ]);
      expect(result.framework).toBe("nextjs-app");
      expect(result.routingFilePatterns).toContain(
        "src/app/**/page.{tsx,jsx,ts,js}",
      );
      expect(result.routingFilePatterns).toContain("src/app/**/layout.*");
    });

    it("defaults to App Router when neither app/ nor pages/ exist", () => {
      const result = detectFramework(pkg({ next: "14.0.0" }), [
        "src/index.tsx",
      ]);
      expect(result.framework).toBe("nextjs-app");
    });
  });

  describe("Next.js (Pages Router)", () => {
    it("detects Pages Router when only pages/ directory exists", () => {
      const result = detectFramework(pkg({ next: "12.0.0", react: "18.0.0" }), [
        "pages/index.tsx",
        "pages/about.tsx",
        "package.json",
      ]);
      expect(result.framework).toBe("nextjs-pages");
      expect(result.routingFilePatterns).toContain(
        "pages/**/*.{tsx,jsx,ts,js}",
      );
    });

    it("detects Pages Router when src/pages/ directory exists", () => {
      const result = detectFramework(pkg({ next: "12.0.0", react: "18.0.0" }), [
        "src/pages/index.tsx",
        "src/pages/about.tsx",
        "package.json",
      ]);
      expect(result.framework).toBe("nextjs-pages");
      expect(result.routingFilePatterns).toContain(
        "src/pages/**/*.{tsx,jsx,ts,js}",
      );
    });

    it("prefers App Router when both app/ and pages/ exist", () => {
      const result = detectFramework(pkg({ next: "14.0.0" }), [
        "app/page.tsx",
        "pages/index.tsx",
      ]);
      expect(result.framework).toBe("nextjs-app");
    });
  });

  describe("Nuxt", () => {
    it("detects Nuxt from dependencies", () => {
      const result = detectFramework(pkg({ nuxt: "3.0.0", vue: "3.0.0" }));
      expect(result.framework).toBe("nuxt");
      expect(result.routingFilePatterns).toContain("pages/**/*.vue");
    });
  });

  describe("Gatsby", () => {
    it("detects Gatsby from dependencies", () => {
      const result = detectFramework(
        pkg({ gatsby: "5.0.0", react: "18.0.0" }),
        ["src/pages/index.tsx", "src/pages/about.tsx"],
      );
      expect(result.framework).toBe("gatsby");
      expect(result.routingFilePatterns).toContain(
        "src/pages/**/*.{tsx,jsx,ts,js}",
      );
    });

    it("detects Gatsby from devDependencies", () => {
      const result = detectFramework(devPkg({ gatsby: "5.0.0" }), [
        "src/pages/index.tsx",
      ]);
      expect(result.framework).toBe("gatsby");
    });

    it("prefers Gatsby over react-router-dom when both present", () => {
      const result = detectFramework(
        pkg({ gatsby: "5.0.0", "react-router-dom": "6.0.0", react: "18.0.0" }),
        ["src/pages/index.tsx"],
      );
      expect(result.framework).toBe("gatsby");
    });
  });

  describe("Astro", () => {
    it("detects Astro from dependencies", () => {
      const result = detectFramework(pkg({ astro: "4.0.0" }), [
        "src/pages/index.astro",
        "src/pages/about.astro",
      ]);
      expect(result.framework).toBe("astro");
      expect(result.routingFilePatterns).toContain(
        "src/pages/**/*.{astro,tsx,jsx,ts,js,md,mdx}",
      );
    });

    it("detects Astro from devDependencies", () => {
      const result = detectFramework(devPkg({ astro: "4.0.0" }), [
        "src/pages/index.astro",
      ]);
      expect(result.framework).toBe("astro");
    });

    it("prefers Astro over react-router-dom when both present", () => {
      const result = detectFramework(
        pkg({ astro: "4.0.0", "react-router-dom": "6.0.0", react: "18.0.0" }),
        ["src/pages/index.astro"],
      );
      expect(result.framework).toBe("astro");
    });

    it("prefers Astro over vue-router when both present", () => {
      const result = detectFramework(
        pkg({ astro: "4.0.0", "vue-router": "4.0.0" }),
        ["src/pages/index.astro"],
      );
      expect(result.framework).toBe("astro");
    });
  });

  describe("Angular", () => {
    it("detects Angular from dependencies", () => {
      const result = detectFramework(
        pkg({ "@angular/core": "17.0.0", "@angular/router": "17.0.0" }),
      );
      expect(result.framework).toBe("angular");
      expect(result.routingFilePatterns).toContain("**/*-routing.module.ts");
      expect(result.routingFilePatterns).toContain("**/app.routes.ts");
    });
  });

  describe("TanStack Router", () => {
    it("detects TanStack Router from dependencies", () => {
      const result = detectFramework(
        pkg({ react: "18.0.0", "@tanstack/react-router": "1.0.0" }),
        ["src/routes/index.tsx", "src/routes/about.tsx"],
      );
      expect(result.framework).toBe("tanstack-router");
      expect(result.routingFilePatterns).toEqual(
        expect.arrayContaining([
          "src/routes/**/*.{tsx,jsx,ts,js}",
          "src/**/routeTree.gen.ts",
          "src/**/router.{tsx,jsx,ts,js}",
        ]),
      );
    });

    it("detects TanStack Router from devDependencies", () => {
      const result = detectFramework(
        devPkg({ "@tanstack/react-router": "1.0.0" }),
        ["src/routes/index.tsx"],
      );
      expect(result.framework).toBe("tanstack-router");
    });

    it("prefers TanStack Router over react-router-dom when both present", () => {
      const result = detectFramework(
        pkg({
          react: "18.0.0",
          "@tanstack/react-router": "1.0.0",
          "react-router-dom": "6.0.0",
        }),
        ["src/routes/index.tsx"],
      );
      expect(result.framework).toBe("tanstack-router");
    });
  });

  describe("React Router", () => {
    it("detects React Router from dependencies", () => {
      const result = detectFramework(
        pkg({ react: "18.0.0", "react-router-dom": "6.0.0" }),
      );
      expect(result.framework).toBe("react-router");
      expect(result.routingFilePatterns).toEqual(
        expect.arrayContaining([
          "src/**/routes.{tsx,jsx,ts,js}",
          "src/**/router.{tsx,jsx,ts,js}",
          "src/**/*.routes.{tsx,jsx,ts,js}",
        ]),
      );
    });
  });

  describe("Vue Router", () => {
    it("detects Vue Router from dependencies", () => {
      const result = detectFramework(
        pkg({ vue: "3.0.0", "vue-router": "4.0.0" }),
      );
      expect(result.framework).toBe("vue-router");
      expect(result.routingFilePatterns).toContain("router/index.{ts,js}");
    });
  });

  describe("Remix", () => {
    it("detects Remix from dependencies", () => {
      const result = detectFramework(
        pkg({ "@remix-run/react": "2.0.0", react: "18.0.0" }),
      );
      expect(result.framework).toBe("remix");
      expect(result.routingFilePatterns).toContain("app/routes/**/*");
    });
  });

  describe("SvelteKit", () => {
    it("detects SvelteKit from devDependencies", () => {
      const result = detectFramework(
        devPkg({ "@sveltejs/kit": "2.0.0", svelte: "4.0.0" }),
      );
      expect(result.framework).toBe("sveltekit");
      expect(result.routingFilePatterns).toContain(
        "src/routes/**/+page.svelte",
      );
    });
  });

  describe("SolidStart", () => {
    it("detects SolidStart from @solidjs/start in dependencies", () => {
      const result = detectFramework(
        pkg({ "@solidjs/start": "1.0.0", "solid-js": "1.8.0" }),
        ["src/routes/index.tsx", "src/routes/about.tsx"],
      );
      expect(result.framework).toBe("solid-start");
      expect(result.routingFilePatterns).toContain(
        "src/routes/**/*.{tsx,jsx,ts,js}",
      );
    });

    it("detects SolidStart from solid-start (legacy) in dependencies", () => {
      const result = detectFramework(
        pkg({ "solid-start": "0.3.0", "solid-js": "1.7.0" }),
        ["src/routes/index.tsx"],
      );
      expect(result.framework).toBe("solid-start");
      expect(result.routingFilePatterns).toContain(
        "src/routes/**/*.{tsx,jsx,ts,js}",
      );
    });

    it("detects SolidStart from @solidjs/start in devDependencies", () => {
      const result = detectFramework(devPkg({ "@solidjs/start": "1.0.0" }), [
        "src/routes/index.tsx",
      ]);
      expect(result.framework).toBe("solid-start");
    });

    it("prefers SolidStart over react-router-dom when both present", () => {
      const result = detectFramework(
        pkg({
          "@solidjs/start": "1.0.0",
          "react-router-dom": "6.0.0",
          "solid-js": "1.8.0",
        }),
        ["src/routes/index.tsx"],
      );
      expect(result.framework).toBe("solid-start");
    });
  });

  describe("Qwik City", () => {
    it("detects Qwik City from @builder.io/qwik-city in dependencies", () => {
      const result = detectFramework(
        pkg({ "@builder.io/qwik-city": "1.5.0", "@builder.io/qwik": "1.5.0" }),
        ["src/routes/index.tsx", "src/routes/about/index.tsx"],
      );
      expect(result.framework).toBe("qwik-city");
      expect(result.routingFilePatterns).toContain(
        "src/routes/**/index.{tsx,jsx,ts,js}",
      );
      expect(result.routingFilePatterns).toContain(
        "src/routes/**/layout.{tsx,jsx,ts,js}",
      );
    });

    it("detects Qwik City from devDependencies", () => {
      const result = detectFramework(
        devPkg({ "@builder.io/qwik-city": "1.5.0" }),
        ["src/routes/index.tsx"],
      );
      expect(result.framework).toBe("qwik-city");
    });

    it("prefers Qwik City over react-router-dom when both present", () => {
      const result = detectFramework(
        pkg({
          "@builder.io/qwik-city": "1.5.0",
          "react-router-dom": "6.0.0",
          "@builder.io/qwik": "1.5.0",
        }),
        ["src/routes/index.tsx"],
      );
      expect(result.framework).toBe("qwik-city");
    });

    it("prefers Qwik City over vue-router when both present", () => {
      const result = detectFramework(
        pkg({
          "@builder.io/qwik-city": "1.5.0",
          "vue-router": "4.0.0",
        }),
        ["src/routes/index.tsx"],
      );
      expect(result.framework).toBe("qwik-city");
    });
  });

  describe("Ember.js", () => {
    it("detects Ember.js from ember-source in dependencies", () => {
      const result = detectFramework(
        pkg({ "ember-source": "5.4.0", "ember-cli": "5.4.0" }),
        ["app/router.js", "app/routes/about.js"],
      );
      expect(result.framework).toBe("ember");
      expect(result.routingFilePatterns).toContain("app/router.{js,ts}");
      expect(result.routingFilePatterns).toContain(
        "app/routes/**/*.{js,ts}",
      );
    });

    it("detects Ember.js from devDependencies", () => {
      const result = detectFramework(
        devPkg({ "ember-source": "5.4.0" }),
        ["app/router.js"],
      );
      expect(result.framework).toBe("ember");
    });

    it("prefers Ember.js over react-router-dom when both present", () => {
      const result = detectFramework(
        pkg({
          "ember-source": "5.4.0",
          "react-router-dom": "6.0.0",
        }),
        ["app/router.js"],
      );
      expect(result.framework).toBe("ember");
    });

    it("prefers Ember.js over vue-router when both present", () => {
      const result = detectFramework(
        pkg({
          "ember-source": "5.4.0",
          "vue-router": "4.0.0",
        }),
        ["app/router.js"],
      );
      expect(result.framework).toBe("ember");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Edge cases
  // ---------------------------------------------------------------------------
  describe("Edge cases", () => {
    it("throws UnsupportedFrameworkError when no framework is detected", () => {
      expect(() => detectFramework(pkg({ lodash: "4.0.0" }))).toThrow(
        UnsupportedFrameworkError,
      );
    });

    it("throws UnsupportedFrameworkError for empty package.json", () => {
      expect(() => detectFramework({})).toThrow(UnsupportedFrameworkError);
    });

    it("throws UnsupportedFrameworkError when deps are empty objects", () => {
      expect(() =>
        detectFramework({ dependencies: {}, devDependencies: {} }),
      ).toThrow(UnsupportedFrameworkError);
    });

    it("error message is descriptive", () => {
      expect(() => detectFramework({})).toThrow(
        "No supported frontend framework or HTML files detected",
      );
    });

    describe("priority when multiple frameworks are present", () => {
      it("prefers Next.js over react-router-dom", () => {
        const result = detectFramework(
          pkg({ next: "14.0.0", "react-router-dom": "6.0.0", react: "18.0.0" }),
          ["app/page.tsx"],
        );
        expect(result.framework).toBe("nextjs-app");
      });

      it("prefers Nuxt over vue-router", () => {
        const result = detectFramework(
          pkg({ nuxt: "3.0.0", "vue-router": "4.0.0", vue: "3.0.0" }),
        );
        expect(result.framework).toBe("nuxt");
      });

      it("prefers Remix over react-router-dom", () => {
        const result = detectFramework(
          pkg({
            "@remix-run/react": "2.0.0",
            "react-router-dom": "6.0.0",
            react: "18.0.0",
          }),
        );
        expect(result.framework).toBe("remix");
      });

      it("prefers SvelteKit over vue-router when both present", () => {
        const result = detectFramework(
          devPkg({ "@sveltejs/kit": "2.0.0", "vue-router": "4.0.0" }),
        );
        expect(result.framework).toBe("sveltekit");
      });
    });

    it("detects framework from devDependencies", () => {
      const result = detectFramework(devPkg({ "@angular/core": "17.0.0" }));
      expect(result.framework).toBe("angular");
    });

    it("detects framework when present in both deps and devDeps", () => {
      const result = detectFramework(
        {
          dependencies: { react: "18.0.0" },
          devDependencies: { next: "14.0.0" },
        },
        ["app/page.tsx"],
      );
      expect(result.framework).toBe("nextjs-app");
    });

    it("handles Next.js with bare app directory path", () => {
      const result = detectFramework(pkg({ next: "14.0.0" }), ["app"]);
      expect(result.framework).toBe("nextjs-app");
    });

    it("handles Next.js with bare pages directory path", () => {
      const result = detectFramework(pkg({ next: "14.0.0" }), ["pages"]);
      expect(result.framework).toBe("nextjs-pages");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Plain HTML fallback
  // ---------------------------------------------------------------------------
  describe("Plain HTML fallback", () => {
    it("detects plain-html when no framework matches and .html files exist", () => {
      const result = detectFramework(pkg({ lodash: "4.0.0" }), [
        "index.html",
        "about.html",
        "css/style.css",
      ]);
      expect(result.framework).toBe("plain-html");
      expect(result.routingFilePatterns).toContain("**/*.html");
    });

    it("detects plain-html with empty package.json when .html files exist", () => {
      const result = detectFramework({}, ["index.html", "contact/index.html"]);
      expect(result.framework).toBe("plain-html");
      expect(result.routingFilePatterns).toEqual(["**/*.html"]);
    });

    it("detects plain-html when package.json has no relevant dependencies", () => {
      const result = detectFramework(
        { dependencies: {}, devDependencies: {} },
        ["index.html"],
      );
      expect(result.framework).toBe("plain-html");
    });

    it("does not detect plain-html when a framework is present", () => {
      const result = detectFramework(pkg({ next: "14.0.0" }), [
        "app/page.tsx",
        "public/index.html",
      ]);
      expect(result.framework).toBe("nextjs-app");
    });

    it("ignores .html files in non-source directories (node_modules, dist, etc.)", () => {
      expect(() =>
        detectFramework(pkg({ lodash: "4.0.0" }), [
          "node_modules/some-lib/index.html",
          "dist/index.html",
          "build/index.html",
          ".next/server/index.html",
          "out/index.html",
          ".nuxt/index.html",
          ".svelte-kit/index.html",
          "vendor/index.html",
          "public/index.html",
          "static/index.html",
        ]),
      ).toThrow(UnsupportedFrameworkError);
    });

    it("throws UnsupportedFrameworkError when no framework and no .html files", () => {
      expect(() =>
        detectFramework(pkg({ lodash: "4.0.0" }), ["src/main.py"]),
      ).toThrow(UnsupportedFrameworkError);
    });

    it("throws UnsupportedFrameworkError for empty file tree and no framework", () => {
      expect(() => detectFramework({}, [])).toThrow(UnsupportedFrameworkError);
    });
  });
});

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------
describe("detectPlatform", () => {
  it("returns 'android' when build.gradle exists at root", () => {
    expect(detectPlatform(["build.gradle", "app/src/main/java/Main.kt"])).toBe(
      "android",
    );
  });

  it("returns 'android' when build.gradle.kts exists at root", () => {
    expect(detectPlatform(["build.gradle.kts", "settings.gradle.kts"])).toBe(
      "android",
    );
  });

  it("returns 'android' when settings.gradle exists at root", () => {
    expect(detectPlatform(["settings.gradle", "gradle.properties"])).toBe(
      "android",
    );
  });

  it("returns 'android' when AndroidManifest.xml exists", () => {
    expect(
      detectPlatform(["app/src/main/AndroidManifest.xml", "README.md"]),
    ).toBe("android");
  });

  it("ignores AndroidManifest.xml in excluded directories", () => {
    expect(detectPlatform(["build/AndroidManifest.xml"])).toBe("web");
  });

  it("returns 'web' when no Android indicators are present", () => {
    expect(detectPlatform(["package.json", "src/index.tsx"])).toBe("web");
  });

  it("returns 'web' for empty file tree", () => {
    expect(detectPlatform([])).toBe("web");
  });

  it("returns 'android' when build.gradle exists only in a subdirectory (multi-module)", () => {
    expect(detectPlatform(["app/build.gradle", "README.md"])).toBe("android");
  });

  it("returns 'android' when build.gradle.kts exists only in a subdirectory", () => {
    expect(detectPlatform(["app/build.gradle.kts", "gradle.properties"])).toBe(
      "android",
    );
  });

  it("ignores Gradle files in excluded directories", () => {
    expect(detectPlatform([".gradle/build.gradle", "README.md"])).toBe("web");
  });
});

// ---------------------------------------------------------------------------
// Android framework detection
// ---------------------------------------------------------------------------
describe("detectAndroidFramework", () => {
  it("detects android-compose-navigation when build.gradle contains navigation-compose", () => {
    const result = detectAndroidFramework([
      {
        path: "app/build.gradle.kts",
        content: `
          dependencies {
            implementation("androidx.navigation:navigation-compose:2.7.0")
          }
        `,
      },
    ]);
    expect(result.framework).toBe("android-compose-navigation");
    expect(result.routingFilePatterns).toContain("**/*NavGraph.kt");
    expect(result.routingFilePatterns).toContain("**/*Screen.kt");
    expect(result.routingFilePatterns).toContain("**/*Navigation.kt");
  });

  it("detects android-compose-navigation when build.gradle contains androidx.navigation.compose", () => {
    const result = detectAndroidFramework([
      {
        path: "app/build.gradle",
        content: `
          implementation 'androidx.navigation.compose:1.0.0'
        `,
      },
    ]);
    expect(result.framework).toBe("android-compose-navigation");
  });

  it("detects android-navigation when build.gradle contains navigation-fragment", () => {
    const result = detectAndroidFramework([
      {
        path: "app/build.gradle.kts",
        content: `
          dependencies {
            implementation("androidx.navigation:navigation-fragment-ktx:2.7.0")
            implementation("androidx.navigation:navigation-ui-ktx:2.7.0")
          }
        `,
      },
    ]);
    expect(result.framework).toBe("android-navigation");
    expect(result.routingFilePatterns).toContain("**/res/navigation/*.xml");
    expect(result.routingFilePatterns).toContain("**/AndroidManifest.xml");
    expect(result.routingFilePatterns).toContain("**/*Fragment.kt");
    expect(result.routingFilePatterns).toContain("**/*Fragment.java");
  });

  it("detects android-navigation when build.gradle contains androidx.navigation", () => {
    const result = detectAndroidFramework([
      {
        path: "app/build.gradle",
        content: `
          implementation 'androidx.navigation:navigation-fragment:2.5.0'
        `,
      },
    ]);
    expect(result.framework).toBe("android-navigation");
  });

  it("prefers compose-navigation over standard navigation when both present", () => {
    const result = detectAndroidFramework([
      {
        path: "app/build.gradle.kts",
        content: `
          dependencies {
            implementation("androidx.navigation:navigation-fragment-ktx:2.7.0")
            implementation("androidx.navigation:navigation-compose:2.7.0")
          }
        `,
      },
    ]);
    expect(result.framework).toBe("android-compose-navigation");
  });

  it("falls back to android-navigation for generic Android project", () => {
    const result = detectAndroidFramework([
      {
        path: "app/build.gradle",
        content: `
          dependencies {
            implementation 'com.google.android.material:material:1.9.0'
          }
        `,
      },
    ]);
    expect(result.framework).toBe("android-navigation");
    expect(result.routingFilePatterns).toContain("**/*Activity.kt");
    expect(result.routingFilePatterns).toContain("**/*Activity.java");
  });

  it("falls back to android-navigation when no build files provided", () => {
    const result = detectAndroidFramework([]);
    expect(result.framework).toBe("android-navigation");
  });

  it("scans across multiple build files", () => {
    const result = detectAndroidFramework([
      {
        path: "build.gradle.kts",
        content: "plugins { id 'com.android.application' }",
      },
      {
        path: "app/build.gradle.kts",
        content: `
          dependencies {
            implementation("androidx.navigation:navigation-compose:2.7.0")
          }
        `,
      },
    ]);
    expect(result.framework).toBe("android-compose-navigation");
  });
});

// ---------------------------------------------------------------------------
// Platform detection — iOS
// ---------------------------------------------------------------------------
describe("detectPlatform — iOS", () => {
  it("returns 'ios' when .xcodeproj/project.pbxproj exists", () => {
    expect(
      detectPlatform(["MyApp.xcodeproj/project.pbxproj", "Sources/App.swift"]),
    ).toBe("ios");
  });

  it("returns 'web' when only Package.swift exists (server-side Swift)", () => {
    expect(detectPlatform(["Package.swift", "Sources/main.swift"])).toBe("web");
  });

  it("returns 'ios' when Package.swift exists with .xcodeproj", () => {
    expect(
      detectPlatform([
        "Package.swift",
        "MyApp.xcodeproj/project.pbxproj",
        "Sources/main.swift",
      ]),
    ).toBe("ios");
  });

  it("returns 'ios' when Podfile exists at root", () => {
    expect(detectPlatform(["Podfile", "MyApp/ViewController.swift"])).toBe(
      "ios",
    );
  });

  it("returns 'ios' when .xcworkspace/contents.xcworkspacedata exists", () => {
    expect(
      detectPlatform([
        "MyApp.xcworkspace/contents.xcworkspacedata",
        "MyApp/AppDelegate.swift",
      ]),
    ).toBe("ios");
  });

  it("does not detect ios from a broad .xcworkspace substring match", () => {
    // A file path that contains ".xcworkspace" but is not the precise contents file
    expect(detectPlatform(["logs/MyApp.xcworkspace.log"])).toBe("web");
  });

  it("ignores .xcodeproj in excluded directories", () => {
    expect(detectPlatform(["Pods/SomePod.xcodeproj/project.pbxproj"])).toBe(
      "web",
    );
  });

  it("prefers android over ios when both indicators present", () => {
    // Android detection runs first in detectPlatform
    expect(
      detectPlatform(["build.gradle", "MyApp.xcodeproj/project.pbxproj"]),
    ).toBe("android");
  });
});

// ---------------------------------------------------------------------------
// isIOSFramework helper
// ---------------------------------------------------------------------------
describe("isIOSFramework", () => {
  it("returns true for ios-swiftui", () => {
    expect(isIOSFramework("ios-swiftui")).toBe(true);
  });

  it("returns true for ios-uikit", () => {
    expect(isIOSFramework("ios-uikit")).toBe(true);
  });

  it("returns false for android frameworks", () => {
    expect(isIOSFramework("android-navigation")).toBe(false);
  });

  it("returns false for web frameworks", () => {
    expect(isIOSFramework("nextjs-app")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// iOS framework detection
// ---------------------------------------------------------------------------
describe("detectiOSFramework", () => {
  it("detects ios-swiftui when SwiftUI import and NavigationStack are found", () => {
    const result = detectiOSFramework(
      [
        {
          path: "Sources/ContentView.swift",
          content: `
            import SwiftUI

            struct ContentView: View {
              var body: some View {
                NavigationStack {
                  HomeView()
                }
              }
            }
          `,
        },
      ],
      ["MyApp.xcodeproj/project.pbxproj", "Sources/ContentView.swift"],
    );
    expect(result.framework).toBe("ios-swiftui");
    expect(result.routingFilePatterns).toContain("**/*View.swift");
    expect(result.routingFilePatterns).toContain("**/*App.swift");
  });

  it("detects ios-swiftui with NavigationView", () => {
    const result = detectiOSFramework(
      [
        {
          path: "Sources/App.swift",
          content: `
            import SwiftUI

            struct MyApp: App {
              var body: some Scene {
                WindowGroup {
                  NavigationView {
                    HomeView()
                  }
                }
              }
            }
          `,
        },
      ],
      [],
    );
    expect(result.framework).toBe("ios-swiftui");
  });

  it("detects ios-swiftui with NavigationSplitView", () => {
    const result = detectiOSFramework(
      [
        {
          path: "Sources/MainView.swift",
          content: `
            import SwiftUI

            struct MainView: View {
              var body: some View {
                NavigationSplitView {
                  SidebarView()
                } detail: {
                  DetailView()
                }
              }
            }
          `,
        },
      ],
      [],
    );
    expect(result.framework).toBe("ios-swiftui");
  });

  it("detects ios-uikit when storyboard files exist", () => {
    const result = detectiOSFramework(
      [
        {
          path: "Sources/ViewController.swift",
          content: `
            import UIKit

            class HomeViewController: UIViewController {
              override func viewDidLoad() {
                super.viewDidLoad()
              }
            }
          `,
        },
      ],
      ["Main.storyboard", "Sources/ViewController.swift"],
    );
    expect(result.framework).toBe("ios-uikit");
    expect(result.routingFilePatterns).toContain("**/*.storyboard");
    expect(result.routingFilePatterns).toContain("**/*ViewController.swift");
    expect(result.routingFilePatterns).toContain("**/*ViewController.m");
  });

  it("detects ios-uikit when UIViewController subclasses are found", () => {
    const result = detectiOSFramework(
      [
        {
          path: "Sources/LoginViewController.swift",
          content: `
            import UIKit

            class LoginViewController: UIViewController {
              override func viewDidLoad() {
                super.viewDidLoad()
              }
            }
          `,
        },
      ],
      ["MyApp.xcodeproj/project.pbxproj"],
    );
    expect(result.framework).toBe("ios-uikit");
  });

  it("prefers SwiftUI over UIKit when both are present", () => {
    const result = detectiOSFramework(
      [
        {
          path: "Sources/ContentView.swift",
          content: `
            import SwiftUI

            struct ContentView: View {
              var body: some View {
                NavigationStack {
                  Text("Hello")
                }
              }
            }
          `,
        },
        {
          path: "Sources/LegacyVC.swift",
          content: `
            import UIKit
            class LegacyVC: UIViewController {}
          `,
        },
      ],
      ["Main.storyboard"],
    );
    expect(result.framework).toBe("ios-swiftui");
  });

  it("falls back to ios-swiftui for generic iOS project", () => {
    const result = detectiOSFramework(
      [
        {
          path: "Sources/App.swift",
          content: `
            import Foundation
            print("Hello")
          `,
        },
      ],
      ["MyApp.xcodeproj/project.pbxproj"],
    );
    expect(result.framework).toBe("ios-swiftui");
  });

  it("falls back to ios-swiftui when no source files provided", () => {
    const result = detectiOSFramework([], ["MyApp.xcodeproj/project.pbxproj"]);
    expect(result.framework).toBe("ios-swiftui");
  });

  it("ignores storyboard files in excluded directories", () => {
    const result = detectiOSFramework(
      [
        {
          path: "Sources/App.swift",
          content: "import Foundation\nlet x = 1",
        },
      ],
      ["Pods/SomeLib/Main.storyboard"],
    );
    // No UIViewController, storyboard is in Pods/ (excluded), so fallback
    expect(result.framework).toBe("ios-swiftui");
  });

  it("detects ios-uikit from Objective-C .m files with UIViewController", () => {
    const result = detectiOSFramework(
      [
        {
          path: "Sources/ViewController.m",
          content: `
            #import <UIKit/UIKit.h>
            @interface ViewController : UIViewController
            @end
          `,
        },
      ],
      ["MyApp.xcodeproj/project.pbxproj"],
    );
    expect(result.framework).toBe("ios-uikit");
  });

  it("detects ios-uikit from Objective-C .h files with UIViewController", () => {
    const result = detectiOSFramework(
      [
        {
          path: "Sources/ViewController.h",
          content: `
            #import <UIKit/UIKit.h>
            @interface ViewController : UIViewController
            @end
          `,
        },
      ],
      ["MyApp.xcodeproj/project.pbxproj"],
    );
    expect(result.framework).toBe("ios-uikit");
  });
});

// ---------------------------------------------------------------------------
// Platform detection — Flutter
// ---------------------------------------------------------------------------
describe("detectPlatform — Flutter", () => {
  it("returns 'flutter' when pubspec.yaml and lib/main.dart exist", () => {
    expect(detectPlatform(["pubspec.yaml", "lib/main.dart"])).toBe("flutter");
  });

  it("returns 'flutter' when pubspec.yaml and android/ dir exist", () => {
    expect(detectPlatform(["pubspec.yaml", "android/build.gradle"])).toBe(
      "flutter",
    );
  });

  it("returns 'flutter' when pubspec.yaml and ios/ dir exist", () => {
    expect(
      detectPlatform(["pubspec.yaml", "ios/Runner.xcodeproj/project.pbxproj"]),
    ).toBe("flutter");
  });

  it("returns 'web' when pubspec.yaml exists without Flutter indicators (pure Dart)", () => {
    expect(detectPlatform(["pubspec.yaml", "bin/server.dart"])).toBe("web");
  });

  it("prefers flutter over android when both pubspec.yaml and build.gradle exist", () => {
    // Flutter projects contain android/ with Gradle files; pubspec.yaml takes priority
    expect(
      detectPlatform([
        "pubspec.yaml",
        "android/build.gradle",
        "android/app/build.gradle",
        "lib/main.dart",
      ]),
    ).toBe("flutter");
  });

  it("prefers flutter over ios when both pubspec.yaml and .xcodeproj exist", () => {
    expect(
      detectPlatform([
        "pubspec.yaml",
        "ios/Runner.xcodeproj/project.pbxproj",
        "lib/main.dart",
      ]),
    ).toBe("flutter");
  });

  it("returns 'android' when no pubspec.yaml exists but Gradle files do", () => {
    expect(
      detectPlatform(["build.gradle", "app/src/main/AndroidManifest.xml"]),
    ).toBe("android");
  });
});

// ---------------------------------------------------------------------------
// Platform detection — React Native / Expo (package.json + native dirs)
// ---------------------------------------------------------------------------
describe("detectPlatform — React Native coexistence", () => {
  it("returns 'web' when package.json coexists with android/app/build.gradle", () => {
    expect(
      detectPlatform([
        "package.json",
        "android/app/build.gradle",
        "src/App.tsx",
      ]),
    ).toBe("web");
  });

  it("returns 'web' when package.json coexists with ios/.xcodeproj", () => {
    expect(
      detectPlatform([
        "package.json",
        "ios/MyApp.xcodeproj/project.pbxproj",
        "src/App.tsx",
      ]),
    ).toBe("web");
  });

  it("returns 'android' for pure Android project without package.json", () => {
    expect(
      detectPlatform([
        "android/app/build.gradle",
        "build.gradle",
        "settings.gradle",
      ]),
    ).toBe("android");
  });

  it("returns 'ios' for pure iOS project without package.json", () => {
    expect(
      detectPlatform([
        "ios/MyApp.xcodeproj/project.pbxproj",
        "Sources/App.swift",
      ]),
    ).toBe("ios");
  });
});

// ---------------------------------------------------------------------------
// Flutter framework detection
// ---------------------------------------------------------------------------
describe("detectFlutterFramework", () => {
  it("detects flutter-go-router when go_router is in dependencies", () => {
    const pubspec = `
name: my_app
dependencies:
  flutter:
    sdk: flutter
  go_router: ^14.0.0
`;
    const result = detectFlutterFramework(pubspec);
    expect(result.framework).toBe("flutter-go-router");
    expect(result.routingFilePatterns).toContain("lib/**/router.dart");
    expect(result.routingFilePatterns).toContain("lib/**/routes.dart");
    expect(result.routingFilePatterns).toContain("lib/**/*_router.dart");
    expect(result.routingFilePatterns).not.toContain("lib/**/*.dart");
  });

  it("detects flutter-auto-route when auto_route is in dependencies", () => {
    const pubspec = `
name: my_app
dependencies:
  flutter:
    sdk: flutter
  auto_route: ^7.0.0
dev_dependencies:
  auto_route_generator: ^7.0.0
`;
    const result = detectFlutterFramework(pubspec);
    expect(result.framework).toBe("flutter-auto-route");
    expect(result.routingFilePatterns).toContain("lib/**/*_router.dart");
    expect(result.routingFilePatterns).toContain("lib/**/*_router.gr.dart");
    expect(result.routingFilePatterns).not.toContain("lib/**/*.dart");
  });

  it("falls back to flutter-navigator when no routing package is found", () => {
    const pubspec = `
name: my_app
dependencies:
  flutter:
    sdk: flutter
`;
    const result = detectFlutterFramework(pubspec);
    expect(result.framework).toBe("flutter-navigator");
    expect(result.routingFilePatterns).toContain("lib/**/main.dart");
    expect(result.routingFilePatterns).toContain("lib/**/app.dart");
  });

  it("prefers go_router over auto_route when both are present", () => {
    const pubspec = `
name: my_app
dependencies:
  flutter:
    sdk: flutter
  go_router: ^14.0.0
  auto_route: ^7.0.0
`;
    const result = detectFlutterFramework(pubspec);
    expect(result.framework).toBe("flutter-go-router");
  });

  it("falls back to flutter-navigator for invalid YAML", () => {
    const result = detectFlutterFramework("invalid: yaml: : :");
    expect(result.framework).toBe("flutter-navigator");
  });

  it("falls back to flutter-navigator for empty string", () => {
    const result = detectFlutterFramework("");
    expect(result.framework).toBe("flutter-navigator");
  });

  it("detects go_router from dev_dependencies", () => {
    const pubspec = `
name: my_app
dependencies:
  flutter:
    sdk: flutter
dev_dependencies:
  go_router: ^14.0.0
`;
    const result = detectFlutterFramework(pubspec);
    expect(result.framework).toBe("flutter-go-router");
  });
});

// ---------------------------------------------------------------------------
// isFlutterFramework helper
// ---------------------------------------------------------------------------
describe("isFlutterFramework", () => {
  it("returns true for flutter-go-router", () => {
    expect(isFlutterFramework("flutter-go-router")).toBe(true);
  });

  it("returns true for flutter-auto-route", () => {
    expect(isFlutterFramework("flutter-auto-route")).toBe(true);
  });

  it("returns true for flutter-navigator", () => {
    expect(isFlutterFramework("flutter-navigator")).toBe(true);
  });

  it("returns false for android frameworks", () => {
    expect(isFlutterFramework("android-navigation")).toBe(false);
  });

  it("returns false for web frameworks", () => {
    expect(isFlutterFramework("nextjs-app")).toBe(false);
  });

  it("returns false for ios frameworks", () => {
    expect(isFlutterFramework("ios-swiftui")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// React Native / Expo framework detection
// ---------------------------------------------------------------------------
describe("React Native / Expo detection", () => {
  describe("Expo Router", () => {
    it("detects expo-router when expo-router is in dependencies", () => {
      const result = detectFramework(
        pkg({
          "expo-router": "3.0.0",
          "react-native": "0.73.0",
          react: "18.0.0",
        }),
      );
      expect(result.framework).toBe("expo-router");
      expect(result.routingFilePatterns).toContain(
        "app/**/_layout.{tsx,jsx,ts,js}",
      );
      expect(result.routingFilePatterns).toContain(
        "app/**/index.{tsx,jsx,ts,js}",
      );
      expect(result.routingFilePatterns).toContain("app/**/*.{tsx,jsx,ts,js}");
    });

    it("prefers expo-router over react-navigation when both present", () => {
      const result = detectFramework(
        pkg({
          "expo-router": "3.0.0",
          "@react-navigation/native": "6.0.0",
          "react-native": "0.73.0",
        }),
      );
      expect(result.framework).toBe("expo-router");
    });

    it("prefers expo-router over react-router-dom when both present", () => {
      const result = detectFramework(
        pkg({
          "expo-router": "3.0.0",
          "react-router-dom": "6.0.0",
          "react-native": "0.73.0",
        }),
      );
      expect(result.framework).toBe("expo-router");
    });
  });

  describe("React Navigation", () => {
    it("detects react-navigation when @react-navigation/native is in dependencies", () => {
      const result = detectFramework(
        pkg({
          "@react-navigation/native": "6.0.0",
          "react-native": "0.73.0",
          react: "18.0.0",
        }),
      );
      expect(result.framework).toBe("react-navigation");
      expect(result.routingFilePatterns).toContain(
        "src/**/navigation/*.{tsx,jsx,ts,js}",
      );
      expect(result.routingFilePatterns).toContain(
        "src/**/*Navigator.{tsx,jsx,ts,js}",
      );
      expect(result.routingFilePatterns).toContain(
        "src/**/*Screen.{tsx,jsx,ts,js}",
      );
    });

    it("prefers react-navigation over react-router-dom when both present", () => {
      const result = detectFramework(
        pkg({
          "@react-navigation/native": "6.0.0",
          "react-router-dom": "6.0.0",
          "react-native": "0.73.0",
        }),
      );
      expect(result.framework).toBe("react-navigation");
    });
  });

  describe("react-native fallback", () => {
    it("falls back to react-navigation when only react-native is in dependencies", () => {
      const result = detectFramework(
        pkg({ "react-native": "0.73.0", react: "18.0.0" }),
      );
      expect(result.framework).toBe("react-navigation");
      expect(result.routingFilePatterns).toContain(
        "src/**/*Navigator.{tsx,jsx,ts,js}",
      );
    });

    it("prefers react-native over react-router-dom", () => {
      const result = detectFramework(
        pkg({
          "react-native": "0.73.0",
          "react-router-dom": "6.0.0",
          react: "18.0.0",
        }),
      );
      expect(result.framework).toBe("react-navigation");
    });
  });
});

// ---------------------------------------------------------------------------
// isReactNativeFramework helper
// ---------------------------------------------------------------------------
describe("isReactNativeFramework", () => {
  it("returns true for expo-router", () => {
    expect(isReactNativeFramework("expo-router")).toBe(true);
  });

  it("returns true for react-navigation", () => {
    expect(isReactNativeFramework("react-navigation")).toBe(true);
  });

  it("returns false for web frameworks", () => {
    expect(isReactNativeFramework("nextjs-app")).toBe(false);
    expect(isReactNativeFramework("react-router")).toBe(false);
  });

  it("returns false for android frameworks", () => {
    expect(isReactNativeFramework("android-navigation")).toBe(false);
  });

  it("returns false for flutter frameworks", () => {
    expect(isReactNativeFramework("flutter-go-router")).toBe(false);
  });

  it("returns false for ios frameworks", () => {
    expect(isReactNativeFramework("ios-swiftui")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAstroFramework helper
// ---------------------------------------------------------------------------
describe("isAstroFramework", () => {
  it("returns true for astro", () => {
    expect(isAstroFramework("astro")).toBe(true);
  });

  it("returns false for web frameworks", () => {
    expect(isAstroFramework("nextjs-app")).toBe(false);
    expect(isAstroFramework("react-router")).toBe(false);
  });

  it("returns false for android frameworks", () => {
    expect(isAstroFramework("android-navigation")).toBe(false);
  });

  it("returns false for flutter frameworks", () => {
    expect(isAstroFramework("flutter-go-router")).toBe(false);
  });

  it("returns false for ios frameworks", () => {
    expect(isAstroFramework("ios-swiftui")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEmberFramework helper
// ---------------------------------------------------------------------------
describe("isEmberFramework", () => {
  it("returns true for ember", () => {
    expect(isEmberFramework("ember")).toBe(true);
  });

  it("returns false for non-ember web frameworks", () => {
    expect(isEmberFramework("nextjs-app")).toBe(false);
    expect(isEmberFramework("react-router")).toBe(false);
    expect(isEmberFramework("angular")).toBe(false);
  });

  it("returns false for android frameworks", () => {
    expect(isEmberFramework("android-navigation")).toBe(false);
  });

  it("returns false for flutter frameworks", () => {
    expect(isEmberFramework("flutter-go-router")).toBe(false);
  });

  it("returns false for ios frameworks", () => {
    expect(isEmberFramework("ios-swiftui")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExcludedPath shared helper
// ---------------------------------------------------------------------------
describe("isExcludedPath", () => {
  it("returns true for node_modules paths", () => {
    expect(isExcludedPath("node_modules/foo/bar.js")).toBe(true);
  });

  it("returns true for Pods paths", () => {
    expect(isExcludedPath("Pods/SomeLib/Main.storyboard")).toBe(true);
  });

  it("returns true for .fvm paths", () => {
    expect(isExcludedPath(".fvm/flutter_sdk/bin/dart")).toBe(true);
  });

  it("returns true for .expo paths", () => {
    expect(isExcludedPath(".expo/types/router.d.ts")).toBe(true);
  });

  it("returns true for .cache paths", () => {
    expect(isExcludedPath(".cache/some-file.json")).toBe(true);
  });

  it("returns true for .gatsby paths", () => {
    expect(isExcludedPath(".gatsby/some-file.json")).toBe(true);
  });

  it("returns true for .astro paths", () => {
    expect(isExcludedPath(".astro/some-file.json")).toBe(true);
  });

  it("returns true for .solid paths", () => {
    expect(isExcludedPath(".solid/some-file.json")).toBe(true);
  });

  it("returns true for .qwik paths", () => {
    expect(isExcludedPath(".qwik/some-file.json")).toBe(true);
  });

  it("returns true for tmp paths", () => {
    expect(isExcludedPath("tmp/some-file.js")).toBe(true);
  });

  it("returns false for android/ paths (not globally excluded)", () => {
    expect(isExcludedPath("android/app/build.gradle")).toBe(false);
  });

  it("returns false for ios/ paths (not globally excluded)", () => {
    expect(isExcludedPath("ios/Podfile.lock")).toBe(false);
  });

  it("returns false for regular source paths", () => {
    expect(isExcludedPath("Sources/App.swift")).toBe(false);
  });

  it("returns false for root-level files", () => {
    expect(isExcludedPath("Package.swift")).toBe(false);
  });
});
