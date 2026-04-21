import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createCustomTools,
  readFileImpl,
  searchFilesImpl,
  grepFilesImpl,
  SEARCH_FILES_MAX_RESULTS,
  GREP_FILES_MAX_RESULTS,
  READ_FILE_MAX_CHARS,
  type RepositoryContext,
} from "./custom-tools.js";
import type { TreeEntry } from "./github-file-fetcher.js";
import type { ToolResultObject } from "@github/copilot-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTreeEntry(
  path: string,
  overrides?: Partial<TreeEntry>,
): TreeEntry {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha: `sha_${path.replace(/[/.]/g, "_")}`,
    size: 500,
    url: `https://api.github.com/repos/owner/repo/git/blobs/sha_${path}`,
    ...overrides,
  };
}

function base64Encode(text: string): string {
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

function makeContext(
  overrides?: Partial<RepositoryContext>,
): RepositoryContext {
  return {
    owner: "owner",
    repo: "repo",
    ref: "main",
    token: "token",
    fileTree: [
      makeTreeEntry("src/app/page.tsx"),
      makeTreeEntry("src/app/about/page.tsx"),
      makeTreeEntry("src/components/Button.tsx"),
      makeTreeEntry("README.md"),
    ],
    ...overrides,
  };
}

function asToolResult(value: unknown): ToolResultObject {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  return value as ToolResultObject;
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe("readFileImpl", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("fetches a known file via the Contents API and returns its content", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        name: "page.tsx",
        path: "src/app/page.tsx",
        sha: "abc",
        size: 50,
        type: "file",
        content: base64Encode("export default function Page() {}"),
        encoding: "base64",
      }),
    );

    const result = await readFileImpl(makeContext(), "src/app/page.tsx");
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("src/app/page.tsx");
    expect(result.textResultForLlm).toContain(
      "export default function Page() {}",
    );
    // Should pass the ref as a query parameter
    const calledUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("ref=main");
  });

  it("returns a failure result (not a throw) when the file is missing", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: "Not Found" }, 404));

    const result = await readFileImpl(
      makeContext(),
      "src/app/does-not-exist.tsx",
    );
    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("404");
  });

  it("returns a failure result on rate-limit errors", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ message: "forbidden" }, 403, {
        "x-ratelimit-remaining": "0",
        "retry-after": "42",
      }),
    );

    const result = await readFileImpl(makeContext(), "src/app/page.tsx");
    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("rate limit");
    expect(result.textResultForLlm).toContain("42");
  });

  it("rejects empty path arguments", async () => {
    const result = await readFileImpl(makeContext(), "");
    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toMatch(/required/i);
  });

  it("falls back to the Contents API when the path is not in the tree", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        name: "unknown.ts",
        path: "unknown.ts",
        sha: "zzz",
        size: 10,
        type: "file",
        content: base64Encode("orphan"),
        encoding: "base64",
      }),
    );

    const result = await readFileImpl(makeContext(), "unknown.ts");
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("orphan");
  });

  it("truncates very large file contents", async () => {
    const huge = "A".repeat(READ_FILE_MAX_CHARS + 2000);
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        name: "page.tsx",
        path: "src/app/page.tsx",
        sha: "abc",
        size: huge.length,
        type: "file",
        content: base64Encode(huge),
        encoding: "base64",
      }),
    );

    const result = await readFileImpl(makeContext(), "src/app/page.tsx");
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toMatch(/truncated/);
    // The emitted body should not exceed the cap by much (header + body)
    expect(result.textResultForLlm.length).toBeLessThan(
      READ_FILE_MAX_CHARS + 500,
    );
  });
});

// ---------------------------------------------------------------------------
// searchFiles
// ---------------------------------------------------------------------------

describe("searchFilesImpl", () => {
  it("returns files whose paths match a glob", () => {
    const result = searchFilesImpl(makeContext(), "**/*.tsx");
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("src/app/page.tsx");
    expect(result.textResultForLlm).toContain("src/app/about/page.tsx");
    expect(result.textResultForLlm).toContain("src/components/Button.tsx");
    // README.md should NOT be included
    expect(result.textResultForLlm).not.toContain("README.md");
  });

  it("reports when a pattern matches nothing", () => {
    const result = searchFilesImpl(makeContext(), "**/*.rs");
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toMatch(/no files matched/i);
  });

  it("rejects empty pattern arguments", () => {
    const result = searchFilesImpl(makeContext(), "");
    expect(result.resultType).toBe("failure");
  });

  it("caps results to SEARCH_FILES_MAX_RESULTS", () => {
    const many: TreeEntry[] = [];
    for (let i = 0; i < SEARCH_FILES_MAX_RESULTS + 25; i++) {
      many.push(makeTreeEntry(`src/generated/file_${i}.ts`));
    }
    const context = makeContext({ fileTree: many });

    const result = searchFilesImpl(context, "src/generated/**/*.ts");
    expect(result.resultType).toBe("success");
    // Header should mention the truncation
    expect(result.textResultForLlm).toMatch(/showing first/i);
    const lineCount = result.textResultForLlm.split("\n").length;
    // Header line + SEARCH_FILES_MAX_RESULTS path lines
    expect(lineCount).toBe(1 + SEARCH_FILES_MAX_RESULTS);
  });
});

// ---------------------------------------------------------------------------
// grepFiles
// ---------------------------------------------------------------------------

describe("grepFilesImpl", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("issues a repo-scoped code search and returns matching paths", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            name: "page.tsx",
            path: "src/app/page.tsx",
            repository: { full_name: "owner/repo" },
          },
          {
            name: "Button.tsx",
            path: "src/components/Button.tsx",
            repository: { full_name: "owner/repo" },
          },
        ],
      }),
    );

    const result = await grepFilesImpl(makeContext(), "router.push");

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("src/app/page.tsx");
    expect(result.textResultForLlm).toContain("src/components/Button.tsx");

    const calledUrl = fetchSpy.mock.calls[0]![0] as string;
    // Must restrict search to this repo
    expect(calledUrl).toContain("repo%3Aowner%2Frepo");
    // Must include the query
    expect(calledUrl).toContain("router.push");
  });

  it("appends a path: filter when a glob is provided", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        total_count: 0,
        incomplete_results: false,
        items: [],
      }),
    );

    await grepFilesImpl(makeContext(), "navigate", "src/**/*.tsx");
    const calledUrl = fetchSpy.mock.calls[0]![0] as string;
    // path:src/**/*.tsx → encoded via encodeURIComponent (slashes and stars
    // pass through encodeURIComponent, but the leading `path:` colon is
    // percent-encoded as %3A).
    expect(calledUrl).toContain(encodeURIComponent("path:src/**/*.tsx"));
  });

  it("reports when code search yields no results", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        total_count: 0,
        incomplete_results: false,
        items: [],
      }),
    );

    const result = await grepFilesImpl(makeContext(), "nothing");
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toMatch(/no code matches/i);
  });

  it("returns a failure result on rate-limit errors", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ message: "rate limited" }, 429, {
        "retry-after": "7",
      }),
    );

    const result = await grepFilesImpl(makeContext(), "foo");
    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("rate limit");
  });

  it("rejects empty query", async () => {
    const result = await grepFilesImpl(makeContext(), "");
    expect(result.resultType).toBe("failure");
  });

  it("caps per_page to GREP_FILES_MAX_RESULTS", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        total_count: 0,
        incomplete_results: false,
        items: [],
      }),
    );
    await grepFilesImpl(makeContext(), "foo");
    const calledUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).toContain(`per_page=${GREP_FILES_MAX_RESULTS}`);
  });
});

// ---------------------------------------------------------------------------
// createCustomTools (factory)
// ---------------------------------------------------------------------------

describe("createCustomTools", () => {
  it("registers readFile, searchFiles, and grepFiles tools", () => {
    const tools = createCustomTools(makeContext());
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["grepFiles", "readFile", "searchFiles"]);

    // Every tool must skip permission (we authorize at the session level) and
    // must declare a parameters schema for the SDK.
    for (const tool of tools) {
      expect(tool.skipPermission).toBe(true);
      expect(tool.parameters).toBeDefined();
      expect(tool.description).toBeTruthy();
    }
  });

  it("tool handlers reject missing required arguments with a failure result", async () => {
    const tools = createCustomTools(makeContext());
    const readFile = tools.find((t) => t.name === "readFile")!;
    const searchFiles = tools.find((t) => t.name === "searchFiles")!;
    const grepFiles = tools.find((t) => t.name === "grepFiles")!;

    const invocation = {
      sessionId: "s",
      toolCallId: "c",
      toolName: "",
      arguments: {},
    };

    const readFileResult = asToolResult(
      await readFile.handler({}, { ...invocation, toolName: "readFile" }),
    );
    expect(readFileResult.resultType).toBe("failure");

    const searchResult = asToolResult(
      await searchFiles.handler({}, { ...invocation, toolName: "searchFiles" }),
    );
    expect(searchResult.resultType).toBe("failure");

    const grepResult = asToolResult(
      await grepFiles.handler({}, { ...invocation, toolName: "grepFiles" }),
    );
    expect(grepResult.resultType).toBe("failure");
  });

  it("searchFiles handler resolves paths without any network call", () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const tools = createCustomTools(makeContext());
    const searchFiles = tools.find((t) => t.name === "searchFiles")!;

    const invocation = {
      sessionId: "s",
      toolCallId: "c",
      toolName: "searchFiles",
      arguments: {},
    };

    const resultMaybe = searchFiles.handler({ pattern: "**/*.md" }, invocation);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The handler may be sync or async; normalise to a ToolResultObject.
    return Promise.resolve(resultMaybe).then((resolved) => {
      const result = asToolResult(resolved);
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("README.md");
      fetchSpy.mockRestore();
    });
  });
});
