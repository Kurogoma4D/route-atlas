import { describe, it, expect } from "vitest";
import {
  buildTurn3ToolPrompt,
  extractRelevantSnippets,
  getNavigationPatterns,
  NAV_KEYWORDS_BY_FRAMEWORK,
} from "./prompts.js";

// ---------------------------------------------------------------------------
// extractRelevantSnippets
// ---------------------------------------------------------------------------

describe("extractRelevantSnippets", () => {
  const patterns = [/router\.navigate/, /\bLink\b/];

  it("returns null when no patterns match", () => {
    const content = `export class Foo {
  bar() { return 42; }
}`;
    expect(extractRelevantSnippets(content, patterns)).toBeNull();
  });

  it("extracts lines around a single match with context", () => {
    const lines = [
      "import { Component } from '@angular/core';",
      "",
      "@Component({})",
      "export class LoginComponent {",
      "  username = '';",
      "  password = '';",
      "  onSubmit() {",
      "    this.router.navigate(['/dashboard']);",
      "  }",
      "  onCancel() {",
      "    console.log('cancel');",
      "  }",
      "}",
    ];
    const content = lines.join("\n");
    const result = extractRelevantSnippets(content, patterns, 2)!;
    expect(result).not.toBeNull();
    // Should include the match line and 2 lines of context
    expect(result).toContain("router.navigate");
    expect(result).toContain("password");
    expect(result).toContain("onCancel");
  });

  it("merges overlapping ranges", () => {
    const lines = [
      "import { Router } from 'router';",
      "",
      "function a() { router.navigate('/a'); }",
      "function b() { return 1; }",
      "function c() { router.navigate('/c'); }",
      "",
      "export default {};",
    ];
    const content = lines.join("\n");
    // With contextLines=1, ranges [1,4] and [3,6] overlap → merged to [1,6]
    const result = extractRelevantSnippets(content, patterns, 1)!;
    expect(result).not.toBeNull();
    // Should NOT have "// ..." between the two matches since they overlap
    const parts = result.split("// ...");
    // imports block + one merged range + trailing ellipsis at most
    expect(parts.length).toBeLessThanOrEqual(3);
  });

  it("includes import block when separate from match ranges", () => {
    const lines = [
      "import { Link } from 'next/link';",
      "import { useState } from 'react';",
      "",
      "// lots of code here",
      "function helper1() { return 1; }",
      "function helper2() { return 2; }",
      "function helper3() { return 3; }",
      "function helper4() { return 4; }",
      "function helper5() { return 5; }",
      "function helper6() { return 6; }",
      "function helper7() { return 7; }",
      "function helper8() { return 8; }",
      "function render() {",
      "  return <Link href='/about'>About</Link>;",
      "}",
    ];
    const content = lines.join("\n");
    // Link appears in imports (line 0) and in render (line 13)
    // With contextLines=2, import match range = [0,2], render match range = [11,14]
    // These don't overlap, so both should appear with "// ..." between
    const result = extractRelevantSnippets(content, patterns, 2)!;
    expect(result).not.toBeNull();
    expect(result).toContain("import { Link }");
    expect(result).toContain("<Link href=");
    expect(result).toContain("// ...");
  });

  it("handles file with only navigation code", () => {
    const content = "router.navigate('/home');";
    const result = extractRelevantSnippets(content, patterns, 5)!;
    expect(result).not.toBeNull();
    expect(result).toContain("router.navigate");
  });
});

// ---------------------------------------------------------------------------
// getNavigationPatterns
// ---------------------------------------------------------------------------

describe("getNavigationPatterns", () => {
  it("returns patterns for web frameworks", () => {
    const patterns = getNavigationPatterns("nextjs-app");
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((p) => p.test("router.push('/foo')"))).toBe(true);
    expect(patterns.some((p) => p.test("<Link href='/bar'>"))).toBe(true);
  });

  it("returns patterns for React Native", () => {
    const patterns = getNavigationPatterns("react-navigation");
    expect(patterns.some((p) => p.test("navigation.navigate('Home')"))).toBe(
      true,
    );
    expect(patterns.some((p) => p.test("navigation.push('Detail')"))).toBe(
      true,
    );
  });

  it("returns patterns for Flutter", () => {
    const patterns = getNavigationPatterns("flutter-go-router");
    expect(patterns.some((p) => p.test("context.go('/home')"))).toBe(true);
    expect(patterns.some((p) => p.test("Navigator.push(context, route)"))).toBe(
      true,
    );
    expect(patterns.some((p) => p.test("showDialog("))).toBe(true);
  });

  it("returns patterns for Android", () => {
    const patterns = getNavigationPatterns("android-compose-navigation");
    expect(patterns.some((p) => p.test('navController.navigate("home")'))).toBe(
      true,
    );
  });

  it("returns patterns for iOS", () => {
    const patterns = getNavigationPatterns("ios-swiftui");
    expect(patterns.some((p) => p.test("NavigationLink(destination:)"))).toBe(
      true,
    );
    expect(patterns.some((p) => p.test(".sheet(isPresented:)"))).toBe(true);
  });

  it("returns patterns for Astro", () => {
    const patterns = getNavigationPatterns("astro");
    expect(patterns.some((p) => p.test('href="/about"'))).toBe(true);
    expect(patterns.some((p) => p.test("Astro.redirect('/login')"))).toBe(true);
  });

  it("returns patterns for Ember", () => {
    const patterns = getNavigationPatterns("ember");
    expect(patterns.some((p) => p.test("this.transitionTo('route')"))).toBe(
      true,
    );
    expect(patterns.some((p) => p.test("<LinkTo @route='index'>"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NAV_KEYWORDS_BY_FRAMEWORK — literal substrings for grepFiles (tool mode)
// ---------------------------------------------------------------------------

describe("NAV_KEYWORDS_BY_FRAMEWORK", () => {
  const allFrameworks: string[] = [
    "nextjs-app",
    "nextjs-pages",
    "nuxt",
    "angular",
    "tanstack-router",
    "react-router",
    "vue-router",
    "remix",
    "sveltekit",
    "plain-html",
    "android-navigation",
    "android-compose-navigation",
    "ios-swiftui",
    "ios-uikit",
    "flutter-go-router",
    "flutter-auto-route",
    "flutter-navigator",
    "gatsby",
    "astro",
    "solid-start",
    "expo-router",
    "react-navigation",
    "qwik-city",
    "ember",
  ];

  it("defines keywords for every supported framework", () => {
    for (const framework of allFrameworks) {
      const keywords = (
        NAV_KEYWORDS_BY_FRAMEWORK as Record<string, string[] | undefined>
      )[framework];
      expect(keywords, `missing keywords for ${framework}`).toBeDefined();
      expect(keywords!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("keywords are literal substrings (no regex constructs)", () => {
    // grepFiles is literal substring search — keywords must NOT include
    // regex-only constructs that would never appear verbatim in source:
    //  - backslash escapes:     \b, \s, \d, \w, \S, \W, \D
    //  - alternations:          foo|bar
    //  - quantifier-as-tail:    foo*, foo+, foo? (final-position quantifier)
    //  - character classes:     [abc]
    // We deliberately do NOT flag bare $ because it's a legal identifier
    // character in JS/Vue (e.g. `$router.push`) and `^` because of C# / XPath.
    const regexOnlyConstructs = /\\[bswdSWD]|\||[[\]]|[*+?]$/;
    for (const [framework, keywords] of Object.entries(
      NAV_KEYWORDS_BY_FRAMEWORK,
    )) {
      for (const kw of keywords) {
        expect(
          regexOnlyConstructs.test(kw),
          `keyword "${kw}" for ${framework} looks like regex, not a literal`,
        ).toBe(false);
      }
    }
  });

  it("react-native keywords include navigation.navigate(", () => {
    expect(NAV_KEYWORDS_BY_FRAMEWORK["react-navigation"]).toContain(
      "navigation.navigate(",
    );
  });

  it("flutter-navigator keywords include Navigator.push(", () => {
    expect(NAV_KEYWORDS_BY_FRAMEWORK["flutter-navigator"]).toContain(
      "Navigator.push(",
    );
  });

  it("android-compose-navigation keywords include navController.navigate(", () => {
    expect(NAV_KEYWORDS_BY_FRAMEWORK["android-compose-navigation"]).toContain(
      "navController.navigate(",
    );
  });

  it("ios-swiftui keywords include NavigationLink", () => {
    expect(NAV_KEYWORDS_BY_FRAMEWORK["ios-swiftui"]).toContain(
      "NavigationLink",
    );
  });
});

// ---------------------------------------------------------------------------
// buildTurn3ToolPrompt — uses NAV_KEYWORDS_BY_FRAMEWORK, not regex sources
// ---------------------------------------------------------------------------

describe("buildTurn3ToolPrompt", () => {
  it("embeds literal keywords, not regex source strings", () => {
    const prompt = buildTurn3ToolPrompt(
      [{ id: "screen_home", path: "/" }],
      ["src/home.tsx"],
      "react-router",
    );

    // Every keyword for this framework must appear in the prompt.
    for (const kw of NAV_KEYWORDS_BY_FRAMEWORK["react-router"]) {
      expect(prompt).toContain(kw);
    }
    // And it must not accidentally embed regex constructs from
    // getNavigationPatterns (e.g. \b, \s*).
    expect(prompt).not.toMatch(/\\b/);
    expect(prompt).not.toMatch(/\\s\*/);
  });

  it("produces non-empty keyword lists for every framework", () => {
    for (const framework of Object.keys(NAV_KEYWORDS_BY_FRAMEWORK)) {
      const prompt = buildTurn3ToolPrompt(
        [{ id: "s", path: "/" }],
        ["a.ts"],
        framework as keyof typeof NAV_KEYWORDS_BY_FRAMEWORK,
      );
      // The bulleted keyword list (backtick-wrapped) must not be empty.
      expect(prompt).toMatch(/- `[^`]+`/);
    }
  });
});
