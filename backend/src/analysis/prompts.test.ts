import { describe, it, expect } from "vitest";
import {
  extractRelevantSnippets,
  getNavigationPatterns,
  SYSTEM_PROMPT_WITH_TOOLS,
  buildTurn2PromptWithTools,
  buildTurn3PromptWithTools,
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
    expect(
      patterns.some((p) => p.test("navController.navigate(\"home\")")),
    ).toBe(true);
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
// SYSTEM_PROMPT_WITH_TOOLS
// ---------------------------------------------------------------------------

describe("SYSTEM_PROMPT_WITH_TOOLS", () => {
  it("includes the base system prompt instructions", () => {
    expect(SYSTEM_PROMPT_WITH_TOOLS).toContain("valid JSON");
  });

  it("documents the three custom tools", () => {
    expect(SYSTEM_PROMPT_WITH_TOOLS).toContain("readFile(path)");
    expect(SYSTEM_PROMPT_WITH_TOOLS).toContain("searchFiles(pattern)");
    expect(SYSTEM_PROMPT_WITH_TOOLS).toContain("grepFiles(query, glob?)");
  });
});

// ---------------------------------------------------------------------------
// buildTurn2PromptWithTools
// ---------------------------------------------------------------------------

describe("buildTurn2PromptWithTools", () => {
  it("references the component file path and asks to call readFile", () => {
    const prompt = buildTurn2PromptWithTools(
      "screen_home",
      "src/app/home.tsx",
      "nextjs-app",
    );
    expect(prompt).toContain("screen_home");
    expect(prompt).toContain("src/app/home.tsx");
    expect(prompt).toContain("readFile");
  });

  it("does NOT embed raw component source", () => {
    const prompt = buildTurn2PromptWithTools(
      "screen_home",
      "src/app/home.tsx",
      "nextjs-app",
    );
    // The tool-based variant must NOT include a ``` fenced code block with source.
    expect(prompt).not.toMatch(/```[\s\S]+export default/);
  });

  it("contains framework-specific look-for items for React Native", () => {
    const prompt = buildTurn2PromptWithTools(
      "screen_home",
      "src/screens/HomeScreen.tsx",
      "react-navigation",
    );
    expect(prompt).toContain("ActivityIndicator");
  });

  it("contains framework-specific look-for items for Flutter", () => {
    const prompt = buildTurn2PromptWithTools(
      "screen_home",
      "lib/screens/home_screen.dart",
      "flutter-go-router",
    );
    expect(prompt).toContain("CircularProgressIndicator");
  });

  it("contains framework-specific look-for items for iOS", () => {
    const prompt = buildTurn2PromptWithTools(
      "screen_home",
      "Sources/Views/HomeView.swift",
      "ios-swiftui",
    );
    expect(prompt).toContain("ProgressView");
  });

  it("contains framework-specific look-for items for Android", () => {
    const prompt = buildTurn2PromptWithTools(
      "screen_home",
      "app/src/main/java/com/example/HomeFragment.kt",
      "android-compose-navigation",
    );
    expect(prompt).toContain("ProgressBar");
  });
});

// ---------------------------------------------------------------------------
// buildTurn3PromptWithTools
// ---------------------------------------------------------------------------

describe("buildTurn3PromptWithTools", () => {
  const screens = [
    { id: "screen_home", path: "/", componentFile: "src/app/home.tsx" },
    { id: "screen_login", path: "/login", componentFile: "src/app/login.tsx" },
  ];
  const candidates = ["src/app/home.tsx", "src/app/login.tsx"];

  it("lists known screens and candidate files", () => {
    const prompt = buildTurn3PromptWithTools(screens, candidates, "nextjs-app");
    expect(prompt).toContain("screen_home");
    expect(prompt).toContain("screen_login");
    expect(prompt).toContain("src/app/home.tsx");
    expect(prompt).toContain("src/app/login.tsx");
  });

  it("instructs the model to use readFile and grepFiles", () => {
    const prompt = buildTurn3PromptWithTools(screens, candidates, "nextjs-app");
    expect(prompt).toContain("readFile");
    expect(prompt).toContain("grepFiles");
  });

  it("does NOT embed file contents", () => {
    const prompt = buildTurn3PromptWithTools(screens, candidates, "nextjs-app");
    // Must not include fenced code blocks with embedded source.
    expect(prompt).not.toMatch(/```[\s\S]{100,}/);
  });

  it("contains framework-specific look-for items for React Native", () => {
    const prompt = buildTurn3PromptWithTools(
      screens,
      candidates,
      "react-navigation",
    );
    expect(prompt).toContain("navigation.navigate");
  });

  it("contains framework-specific look-for items for Flutter", () => {
    const prompt = buildTurn3PromptWithTools(
      screens,
      candidates,
      "flutter-go-router",
    );
    expect(prompt).toContain("Navigator.push");
  });

  it("contains framework-specific look-for items for iOS", () => {
    const prompt = buildTurn3PromptWithTools(
      screens,
      candidates,
      "ios-swiftui",
    );
    expect(prompt).toContain("NavigationLink");
  });

  it("contains framework-specific look-for items for Android", () => {
    const prompt = buildTurn3PromptWithTools(
      screens,
      candidates,
      "android-compose-navigation",
    );
    expect(prompt).toContain("NavController.navigate");
  });
});
