import { describe, it, expect } from "vitest";
import {
  detectFramework,
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
        "No supported frontend framework detected in package.json",
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
