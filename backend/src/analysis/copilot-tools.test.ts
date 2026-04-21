import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAnalysisTools,
  createReadFileTool,
  createSearchFilesTool,
  createGrepFilesTool,
  globToPathQualifier,
  type RepoContext,
} from "./copilot-tools.js";
import type { TreeEntry } from "./github-file-fetcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTreeEntry(path: string, size = 100): TreeEntry {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha: `sha_${path.replace(/[/.]/g, "_")}`,
    size,
    url: `https://api.github.com/repos/acme/widget/git/blobs/${path}`,
  };
}

function base64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function mockResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

const TREE: TreeEntry[] = [
  makeTreeEntry("src/app/page.tsx"),
  makeTreeEntry("src/app/dashboard/page.tsx"),
  makeTreeEntry("src/app/layout.tsx"),
  makeTreeEntry("src/lib/router.ts"),
  makeTreeEntry("src/lib/utils.ts"),
  makeTreeEntry("README.md"),
];

function ctx(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    owner: "acme",
    repo: "widget",
    ref: "main",
    token: "gho_test_token",
    files: TREE,
    ...overrides,
  };
}

// Helper: call a tool handler and force return to string.
async function invoke(
  tool: { handler: (args: unknown, invocation: unknown) => unknown },
  args: unknown,
): Promise<string> {
  const result = await tool.handler(args, {
    sessionId: "s1",
    toolCallId: "t1",
    toolName: "x",
    arguments: args,
  });
  if (typeof result !== "string") {
    throw new Error(`Expected tool to return string, got: ${typeof result}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// createAnalysisTools
// ---------------------------------------------------------------------------

describe("createAnalysisTools", () => {
  it("returns readFile, searchFiles, and grepFiles", () => {
    const tools = createAnalysisTools(ctx());
    expect(tools.map((t) => t.name).sort()).toEqual([
      "grepFiles",
      "readFile",
      "searchFiles",
    ]);
  });

  it("every tool has a description and parameters schema", () => {
    const tools = createAnalysisTools(ctx());
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe("readFile tool", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the decoded file content for a known path", async () => {
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      mockResponse({
        sha: "sha_src_app_page_tsx",
        content: base64("export default function Page() {}"),
        encoding: "base64",
        size: 40,
      }),
    );

    const tool = createReadFileTool(ctx());
    const output = await invoke(tool, { path: "src/app/page.tsx" });

    expect(output).toContain("export default function Page()");
    // Verified with ref in URL
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/contents/src/app/page.tsx");
    expect(url).toContain("ref=main");
  });

  it("returns a 'not found' error when the path is not in the tree", async () => {
    const tool = createReadFileTool(ctx());
    const output = await invoke(tool, { path: "src/nowhere.ts" });
    expect(output).toMatch(/^Error:.*not found/i);
  });

  it("returns a validation error for missing path arg", async () => {
    const tool = createReadFileTool(ctx());
    const output = await invoke(tool, {});
    expect(output).toMatch(/^Error:/);
    expect(output).toContain("path");
  });

  it("returns a validation error when arguments are not an object", async () => {
    const tool = createReadFileTool(ctx());
    const output = await invoke(tool, "src/app/page.tsx");
    expect(output).toMatch(/^Error:/);
  });

  it("maps GitHub 404 responses to a clear 'File not found' string", async () => {
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(mockResponse({ message: "Not Found" }, 404));

    const tool = createReadFileTool(ctx());
    const output = await invoke(tool, { path: "src/app/page.tsx" });
    expect(output).toMatch(/^Error:.*File not found/i);
  });

  it("surfaces rate limit errors with wait time", async () => {
    // Use retry-after: 0 so the internal retry is instantaneous.
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse({ message: "rate limited" }, 403, {
        "x-ratelimit-remaining": "0",
        "retry-after": "0",
      }),
    );

    const tool = createReadFileTool(ctx());
    const output = await invoke(tool, { path: "src/app/page.tsx" });
    expect(output).toMatch(/rate limit/i);
    expect(output).toMatch(/\d+s/);
  });

  it("truncates oversized file content", async () => {
    // 120k A's — bigger than the MAX_READ_FILE_CHARS cap
    const big = "A".repeat(120_000);
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      mockResponse({
        sha: "sha_src_app_page_tsx",
        content: base64(big),
        encoding: "base64",
        size: 120_000,
      }),
    );

    const tool = createReadFileTool(ctx());
    const output = await invoke(tool, { path: "src/app/page.tsx" });
    expect(output).toContain("[truncated");
    expect(output.length).toBeLessThan(big.length);
  });
});

// ---------------------------------------------------------------------------
// searchFiles
// ---------------------------------------------------------------------------

describe("searchFiles tool", () => {
  it("returns matching paths for a glob", async () => {
    const tool = createSearchFilesTool(ctx());
    const output = await invoke(tool, { pattern: "src/app/**/*.tsx" });

    const lines = output.split("\n");
    expect(lines).toContain("src/app/page.tsx");
    expect(lines).toContain("src/app/dashboard/page.tsx");
    expect(lines).toContain("src/app/layout.tsx");
    expect(lines).not.toContain("src/lib/router.ts");
  });

  it("returns a 'no matches' message when nothing matches", async () => {
    const tool = createSearchFilesTool(ctx());
    const output = await invoke(tool, { pattern: "**/*.rs" });
    expect(output).toMatch(/No files match/i);
  });

  it("returns a validation error for a missing pattern", async () => {
    const tool = createSearchFilesTool(ctx());
    const output = await invoke(tool, {});
    expect(output).toMatch(/^Error:/);
    expect(output).toContain("pattern");
  });

  it("caps the number of results", async () => {
    // Build a big tree
    const huge = Array.from({ length: 500 }, (_, i) =>
      makeTreeEntry(`f${i}.ts`),
    );
    const tool = createSearchFilesTool(ctx({ files: huge }));
    const output = await invoke(tool, { pattern: "**/*.ts" });

    // Header line plus ≤ 200 results
    const lines = output.split("\n");
    expect(lines[0]).toMatch(/Showing first 200 of 500/);
    expect(lines.length).toBeLessThanOrEqual(201);
  });
});

// ---------------------------------------------------------------------------
// grepFiles
// ---------------------------------------------------------------------------

describe("grepFiles tool", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns unique paths from GitHub code search", async () => {
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      mockResponse({
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            path: "src/app/page.tsx",
            repository: { full_name: "acme/widget" },
          },
          {
            path: "src/lib/router.ts",
            repository: { full_name: "acme/widget" },
          },
        ],
      }),
    );

    const tool = createGrepFilesTool(ctx());
    const output = await invoke(tool, { query: "useNavigate" });

    expect(output).toContain("src/app/page.tsx");
    expect(output).toContain("src/lib/router.ts");

    // The search URL must scope to the target repo.
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/search/code");
    expect(url).toContain(encodeURIComponent("repo:acme/widget"));
    expect(url).toContain(encodeURIComponent("useNavigate"));
  });

  it("pushes a simple glob into the search URL as a `path:` qualifier", async () => {
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      mockResponse({
        total_count: 1,
        items: [{ path: "src/app/page.tsx" }],
      }),
    );

    const tool = createGrepFilesTool(ctx());
    const output = await invoke(tool, { query: "foo", glob: "src/app/**" });

    expect(output).toContain("src/app/page.tsx");

    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = mockFetch.mock.calls[0][0] as string;
    // `path:src/app` must be pushed down so the filter runs before the cap.
    expect(url).toContain(encodeURIComponent("path:src/app"));
    // Per-page cap stays at 30 when the glob was pushed down successfully.
    expect(url).toContain("per_page=30");
  });

  it("falls back to a client-side post-filter for complex globs and raises per-page to 100", async () => {
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      mockResponse({
        total_count: 2,
        items: [{ path: "src/app/page.tsx" }, { path: "src/lib/router.ts" }],
      }),
    );

    const tool = createGrepFilesTool(ctx());
    // `**/*.tsx` cannot be pushed down — globstar at head.
    const output = await invoke(tool, { query: "foo", glob: "**/*.tsx" });

    // Only the .tsx hit should survive the post-filter.
    expect(output).toContain("src/app/page.tsx");
    expect(output).not.toContain("src/lib/router.ts");

    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = mockFetch.mock.calls[0][0] as string;
    // No `path:` qualifier pushed down.
    expect(url).not.toContain(encodeURIComponent("path:"));
    // Per-page bumped to 100 so glob-matching hits past position 30 aren't lost.
    expect(url).toContain("per_page=100");
  });

  it("mentions the post-filter limit in the header when total_count exceeds hits for a complex glob", async () => {
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      mockResponse({
        // Simulate a "more results than the page" case so the header surfaces.
        total_count: 250,
        items: [{ path: "src/app/page.tsx" }],
      }),
    );

    const tool = createGrepFilesTool(ctx());
    const output = await invoke(tool, { query: "foo", glob: "**/*.tsx" });

    expect(output).toContain("post-filter");
    expect(output).toContain("100");
  });

  it("prefixes the result with a default-branch disclosure when ctx.ref is set", async () => {
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      mockResponse({
        total_count: 1,
        items: [{ path: "src/app/page.tsx" }],
      }),
    );

    const tool = createGrepFilesTool(ctx({ ref: "feature/x" }));
    const output = await invoke(tool, { query: "useNavigate" });

    expect(output.split("\n")[0]).toMatch(/default branch/i);
    expect(output).toContain("src/app/page.tsx");
  });

  it("returns a 'no matches' message when search returns zero hits", async () => {
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(mockResponse({ total_count: 0, items: [] }));

    const tool = createGrepFilesTool(ctx());
    const output = await invoke(tool, { query: "nothingHere" });
    expect(output).toMatch(/^No matches/i);
  });

  it("returns a validation error for missing query", async () => {
    const tool = createGrepFilesTool(ctx());
    const output = await invoke(tool, {});
    expect(output).toMatch(/^Error:/);
    expect(output).toContain("query");
  });

  it("surfaces rate-limit errors from code search", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse({ message: "rate limited" }, 403, {
        "x-ratelimit-remaining": "0",
        "retry-after": "0",
      }),
    );

    const tool = createGrepFilesTool(ctx());
    const output = await invoke(tool, { query: "anything" });
    expect(output).toMatch(/rate limit/i);
  });

  it("surfaces non-rate-limit GitHub errors", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse({ message: "boom" }, 500),
    );

    const tool = createGrepFilesTool(ctx());
    const output = await invoke(tool, { query: "anything" });
    expect(output).toMatch(/^Error: GitHub API error/);
  });

  it("rejects a non-string glob argument", async () => {
    const tool = createGrepFilesTool(ctx());
    const output = await invoke(tool, { query: "foo", glob: 42 });
    expect(output).toMatch(/^Error:/);
    expect(output).toContain("glob");
  });

  // -----------------------------------------------------------------------
  // Prompt-injection hardening — grepFiles must reject any attempt to widen
  // the search scope (qualifiers, booleans, grouping).
  // -----------------------------------------------------------------------
  describe("rejects prompt-injected queries that try to escape the repo scope", () => {
    const attackerInputs: Array<{ label: string; query: string }> = [
      { label: "adds another repo: qualifier", query: "useNavigate repo:evil/leak" },
      { label: "switches to user:", query: "token user:victim" },
      { label: "switches to org:", query: "secret org:anthropic" },
      { label: "uses path: to widen", query: "secret path:.env" },
      { label: "uses language:", query: "AKIA language:python" },
      { label: "uses extension:", query: "PRIVATE_KEY extension:pem" },
      { label: "uses filename:", query: "ignore filename:.env" },
      { label: "uses in:file", query: "secret in:file" },
      { label: "uses fork:", query: "secret fork:true" },
      { label: "stars: numeric qualifier", query: "useNavigate stars:>100" },
      { label: "OR boolean", query: "useNavigate OR router" },
      { label: "AND boolean", query: "foo AND bar" },
      { label: "parenthesised group", query: "(useNavigate)" },
      { label: "trailing OR group", query: "useNavigate OR (repo:evil/other)" },
    ];

    for (const { label, query } of attackerInputs) {
      it(label, async () => {
        const tool = createGrepFilesTool(ctx());
        const output = await invoke(tool, { query });
        expect(output).toMatch(/^Error:/);
        // The offending query must never reach GitHub.
        expect(globalThis.fetch).not.toHaveBeenCalled();
      });
    }
  });

  // -----------------------------------------------------------------------
  // globToPathQualifier — unit coverage for the pushdown translator.
  // -----------------------------------------------------------------------
  describe("globToPathQualifier", () => {
    it("maps a trailing globstar to the directory prefix", () => {
      expect(globToPathQualifier("src/app/**")).toBe("src/app");
    });

    it("maps a mid-path globstar to the prefix before it", () => {
      expect(globToPathQualifier("src/app/**/*.tsx")).toBe("src/app");
    });

    it("strips a trailing wildcard segment", () => {
      expect(globToPathQualifier("src/app/*.tsx")).toBe("src/app");
    });

    it("returns the directory for a plain file glob", () => {
      expect(globToPathQualifier("src/lib/*.ts")).toBe("src/lib");
    });

    it("returns null for a leading-globstar glob", () => {
      expect(globToPathQualifier("**/routes.ts")).toBeNull();
    });

    it("returns null for brace expansion", () => {
      expect(globToPathQualifier("src/app/*.{ts,tsx}")).toBeNull();
    });

    it("returns null for negation", () => {
      expect(globToPathQualifier("!node_modules/**")).toBeNull();
    });

    it("returns null for character classes", () => {
      expect(globToPathQualifier("src/[ab]/*.ts")).toBeNull();
    });

    it("returns null when the glob is just a wildcard", () => {
      expect(globToPathQualifier("*.ts")).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(globToPathQualifier("")).toBeNull();
    });
  });
});
