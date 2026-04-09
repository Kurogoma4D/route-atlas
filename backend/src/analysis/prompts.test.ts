import { describe, it, expect } from "vitest";
import {
  extractRelevantSnippets,
  getNavigationPatterns,
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
