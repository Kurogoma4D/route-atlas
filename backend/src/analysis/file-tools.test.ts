import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createReadFileTool,
  createSearchFilesTool,
  createGrepFilesTool,
  createFileTools,
  GREP_FILES_MAX_RESULTS,
  SEARCH_FILES_MAX_RESULTS,
  READ_FILE_MAX_BYTES,
  type FileToolContext,
} from "./file-tools.js";
import type { TreeEntry } from "./github-file-fetcher.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTreeEntry(path: string, size = 100): TreeEntry {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha: `sha_${path.replace(/[/.]/g, "_")}`,
    size,
    url: `https://api.github.com/repos/owner/repo/git/blobs/sha_${path}`,
  };
}

function base64Encode(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function mockFetchResponse(
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

function makeCtx(overrides: Partial<FileToolContext> = {}): FileToolContext {
  return {
    owner: "acme",
    repo: "demo",
    branch: "main",
    token: "gho_test",
    fileTree: [
      makeTreeEntry("src/app/page.tsx"),
      makeTreeEntry("src/app/dashboard/page.tsx"),
      makeTreeEntry("src/lib/utils.ts"),
      makeTreeEntry("README.md"),
    ],
    preloadedContents: new Map(),
    ...overrides,
  };
}

// We need an invocation arg for ToolHandler calls, but our handlers ignore it.
const INVOCATION = {
  sessionId: "s",
  toolCallId: "c",
  toolName: "x",
  arguments: {},
};

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe("createReadFileTool", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns preloaded content without calling the API", async () => {
    const ctx = makeCtx({
      preloadedContents: new Map([
        ["src/app/page.tsx", "export default function Page() {}"],
      ]),
    });
    const tool = createReadFileTool(ctx);

    const result = await tool.handler({ path: "src/app/page.tsx" }, INVOCATION);

    expect(result).toBe("export default function Page() {}");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches via GitHub Contents API when not preloaded", async () => {
    const content = "console.log('hello');";
    vi.mocked(fetch).mockResolvedValueOnce(
      mockFetchResponse({
        name: "utils.ts",
        path: "src/lib/utils.ts",
        sha: "abc",
        size: content.length,
        type: "file",
        content: base64Encode(content),
        encoding: "base64",
      }),
    );

    const ctx = makeCtx();
    const tool = createReadFileTool(ctx);

    const result = await tool.handler({ path: "src/lib/utils.ts" }, INVOCATION);

    expect(result).toBe(content);
    // Result should now be cached
    expect(ctx.preloadedContents.get("src/lib/utils.ts")).toBe(content);
  });

  it("rejects paths not in the file tree", async () => {
    const ctx = makeCtx();
    const tool = createReadFileTool(ctx);

    const result = await tool.handler(
      { path: "does/not/exist.ts" },
      INVOCATION,
    );

    expect(result).toContain("Error: readFile");
    expect(result).toContain("not in the repository file list");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a rate-limit error message when GitHub rate-limits us", async () => {
    // Use retry-after=0 so the single internal retry doesn't delay the test.
    // After the second 429 the adapter throws GitHubRateLimitError, which
    // our handler catches and formats.
    vi.mocked(fetch).mockResolvedValue(
      mockFetchResponse({ message: "rate limit" }, 429, {
        "retry-after": "0",
      }),
    );

    const ctx = makeCtx();
    const tool = createReadFileTool(ctx);

    const result = await tool.handler({ path: "src/lib/utils.ts" }, INVOCATION);

    expect(result).toContain("Error:");
    expect(result).toContain("rate limit");
  });

  it("returns a 404 error message when the file is missing on GitHub", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockFetchResponse({ message: "Not Found" }, 404),
    );

    const ctx = makeCtx();
    const tool = createReadFileTool(ctx);

    const result = await tool.handler({ path: "src/lib/utils.ts" }, INVOCATION);

    expect(result).toContain("Error:");
    expect(result).toContain("not found");
  });

  it("returns an error for malformed arguments", async () => {
    const ctx = makeCtx();
    const tool = createReadFileTool(ctx);

    // Missing required `path` field
    const r1 = await tool.handler({}, INVOCATION);
    expect(r1).toContain("Error:");

    // Non-string path
    const r2 = await tool.handler({ path: 42 }, INVOCATION);
    expect(r2).toContain("Error:");

    // Empty string
    const r3 = await tool.handler({ path: "   " }, INVOCATION);
    expect(r3).toContain("Error:");
  });

  it("truncates very large files", async () => {
    const huge = "x".repeat(READ_FILE_MAX_BYTES + 5000);
    const ctx = makeCtx({
      preloadedContents: new Map([["src/app/page.tsx", huge]]),
    });
    const tool = createReadFileTool(ctx);

    const result = (await tool.handler(
      { path: "src/app/page.tsx" },
      INVOCATION,
    )) as string;

    expect(result.length).toBeGreaterThanOrEqual(READ_FILE_MAX_BYTES);
    expect(result).toContain("truncated after");
  });
});

// ---------------------------------------------------------------------------
// searchFiles
// ---------------------------------------------------------------------------

describe("createSearchFilesTool", () => {
  it("returns matching paths for a glob pattern", () => {
    const ctx = makeCtx();
    const tool = createSearchFilesTool(ctx);

    const result = tool.handler(
      { pattern: "src/app/**/page.tsx" },
      INVOCATION,
    ) as string;

    const lines = result.split("\n");
    expect(lines).toContain("src/app/page.tsx");
    expect(lines).toContain("src/app/dashboard/page.tsx");
    expect(lines).not.toContain("src/lib/utils.ts");
  });

  it("reports when no files match", () => {
    const ctx = makeCtx();
    const tool = createSearchFilesTool(ctx);

    const result = tool.handler({ pattern: "**/*.vue" }, INVOCATION) as string;

    expect(result).toContain("No files match");
  });

  it("caps results at SEARCH_FILES_MAX_RESULTS", () => {
    // Create more files than the cap
    const many: TreeEntry[] = [];
    for (let i = 0; i < SEARCH_FILES_MAX_RESULTS + 20; i++) {
      many.push(makeTreeEntry(`src/file-${i}.tsx`));
    }

    const ctx = makeCtx({ fileTree: many });
    const tool = createSearchFilesTool(ctx);

    const result = tool.handler(
      { pattern: "src/**/*.tsx" },
      INVOCATION,
    ) as string;

    const lines = result.split("\n");
    expect(lines).toHaveLength(SEARCH_FILES_MAX_RESULTS);
  });

  it("returns an error for malformed arguments", () => {
    const ctx = makeCtx();
    const tool = createSearchFilesTool(ctx);

    expect(tool.handler({}, INVOCATION)).toContain("Error:");
    expect(tool.handler({ pattern: "" }, INVOCATION)).toContain("Error:");
    expect(tool.handler({ pattern: 5 }, INVOCATION)).toContain("Error:");
  });
});

// ---------------------------------------------------------------------------
// grepFiles
// ---------------------------------------------------------------------------

describe("createGrepFilesTool", () => {
  it("finds case-insensitive substring matches in preloaded files", () => {
    const ctx = makeCtx({
      preloadedContents: new Map([
        [
          "src/app/page.tsx",
          "import { useRouter } from 'next/router';\nrouter.push('/home');",
        ],
        ["src/lib/utils.ts", "export const noop = () => {};"],
      ]),
    });
    const tool = createGrepFilesTool(ctx);

    const result = tool.handler({ query: "router.push" }, INVOCATION) as string;

    expect(result).toContain("src/app/page.tsx:2:");
    expect(result).toContain("router.push('/home')");
    expect(result).not.toContain("src/lib/utils.ts");
  });

  it("is case-insensitive", () => {
    const ctx = makeCtx({
      preloadedContents: new Map([["a.ts", "NAVIGATE('home');"]]),
    });
    const tool = createGrepFilesTool(ctx);

    const result = tool.handler({ query: "navigate" }, INVOCATION) as string;

    expect(result).toContain("NAVIGATE");
  });

  it("restricts search by glob when provided", () => {
    const ctx = makeCtx({
      preloadedContents: new Map([
        ["app/page.tsx", "router.push('/a');"],
        ["lib/helper.ts", "router.push('/b');"],
      ]),
    });
    const tool = createGrepFilesTool(ctx);

    const result = tool.handler(
      { query: "router.push", glob: "app/**/*.tsx" },
      INVOCATION,
    ) as string;

    expect(result).toContain("app/page.tsx");
    expect(result).not.toContain("lib/helper.ts");
  });

  it("reports when no matches are found", () => {
    const ctx = makeCtx({
      preloadedContents: new Map([["a.ts", "hello world"]]),
    });
    const tool = createGrepFilesTool(ctx);

    const result = tool.handler({ query: "goodbye" }, INVOCATION) as string;

    expect(result).toContain("No matches");
  });

  it("caps results at GREP_FILES_MAX_RESULTS", () => {
    const content = Array.from({ length: GREP_FILES_MAX_RESULTS + 20 })
      .map((_, i) => `line ${i} router.push('x');`)
      .join("\n");
    const ctx = makeCtx({
      preloadedContents: new Map([["a.ts", content]]),
    });
    const tool = createGrepFilesTool(ctx);

    const result = tool.handler({ query: "router.push" }, INVOCATION) as string;

    expect(result.split("\n")).toHaveLength(GREP_FILES_MAX_RESULTS);
  });

  it("returns an error for malformed arguments", () => {
    const ctx = makeCtx();
    const tool = createGrepFilesTool(ctx);

    expect(tool.handler({}, INVOCATION)).toContain("Error:");
    expect(tool.handler({ query: "" }, INVOCATION)).toContain("Error:");
    expect(tool.handler({ query: 1 }, INVOCATION)).toContain("Error:");
    expect(tool.handler({ query: "x", glob: 2 }, INVOCATION)).toContain(
      "Error:",
    );
  });
});

// ---------------------------------------------------------------------------
// createFileTools
// ---------------------------------------------------------------------------

describe("createFileTools", () => {
  it("returns all three tools with the expected names and skipPermission", () => {
    const tools = createFileTools(makeCtx());

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      "readFile",
      "searchFiles",
      "grepFiles",
    ]);
    for (const t of tools) {
      expect(t.skipPermission).toBe(true);
      expect(t.description).toBeTruthy();
      expect(t.parameters).toBeTruthy();
    }
  });
});
