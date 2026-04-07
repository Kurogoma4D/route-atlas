import { describe, it, expect } from "vitest";
import {
  detectFramework,
  detectPlatform,
  detectAndroidFramework,
  detectiOSFramework,
  isIOSFramework,
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
    expect(detectPlatform(["build.gradle", "app/src/main/java/Main.kt"])).toBe("android");
  });

  it("returns 'android' when build.gradle.kts exists at root", () => {
    expect(detectPlatform(["build.gradle.kts", "settings.gradle.kts"])).toBe("android");
  });

  it("returns 'android' when settings.gradle exists at root", () => {
    expect(detectPlatform(["settings.gradle", "gradle.properties"])).toBe("android");
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
    expect(detectPlatform(["app/build.gradle.kts", "gradle.properties"])).toBe("android");
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
    expect(detectPlatform(["MyApp.xcodeproj/project.pbxproj", "Sources/App.swift"])).toBe("ios");
  });

  it("returns 'web' when only Package.swift exists (server-side Swift)", () => {
    expect(detectPlatform(["Package.swift", "Sources/main.swift"])).toBe("web");
  });

  it("returns 'ios' when Package.swift exists with .xcodeproj", () => {
    expect(detectPlatform(["Package.swift", "MyApp.xcodeproj/project.pbxproj", "Sources/main.swift"])).toBe("ios");
  });

  it("returns 'ios' when Podfile exists at root", () => {
    expect(detectPlatform(["Podfile", "MyApp/ViewController.swift"])).toBe("ios");
  });

  it("returns 'ios' when .xcworkspace/contents.xcworkspacedata exists", () => {
    expect(detectPlatform(["MyApp.xcworkspace/contents.xcworkspacedata", "MyApp/AppDelegate.swift"])).toBe("ios");
  });

  it("does not detect ios from a broad .xcworkspace substring match", () => {
    // A file path that contains ".xcworkspace" but is not the precise contents file
    expect(detectPlatform(["logs/MyApp.xcworkspace.log"])).toBe("web");
  });

  it("ignores .xcodeproj in excluded directories", () => {
    expect(detectPlatform(["Pods/SomePod.xcodeproj/project.pbxproj"])).toBe("web");
  });

  it("prefers android over ios when both indicators present", () => {
    // Android detection runs first in detectPlatform
    expect(detectPlatform(["build.gradle", "MyApp.xcodeproj/project.pbxproj"])).toBe("android");
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
// isExcludedPath shared helper
// ---------------------------------------------------------------------------
describe("isExcludedPath", () => {
  it("returns true for node_modules paths", () => {
    expect(isExcludedPath("node_modules/foo/bar.js")).toBe(true);
  });

  it("returns true for Pods paths", () => {
    expect(isExcludedPath("Pods/SomeLib/Main.storyboard")).toBe(true);
  });

  it("returns false for regular source paths", () => {
    expect(isExcludedPath("Sources/App.swift")).toBe(false);
  });

  it("returns false for root-level files", () => {
    expect(isExcludedPath("Package.swift")).toBe(false);
  });
});
