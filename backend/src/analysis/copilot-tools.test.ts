import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildRepoTools,
  coerceGrepFilesArgs,
  coerceReadFileArgs,
  coerceSearchFilesArgs,
  handleGrepFiles,
  handleReadFile,
  handleSearchFiles,
  type RepoContext,
} from "./copilot-tools.js";
import type { TreeEntry } from "./github-file-fetcher.js";

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
    size: 1000,
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

function makeContext(entries: TreeEntry[]): RepoContext {
  return {
    owner: "acme",
    repo: "widgets",
    branch: "main",
    token: "test-token",
    treeFiles: entries,
  };
}

// ---------------------------------------------------------------------------
// handleSearchFiles
// ---------------------------------------------------------------------------

describe("handleSearchFiles", () => {
  const ctx = makeContext([
    makeTreeEntry("src/app/home.tsx"),
    makeTreeEntry("src/app/about.tsx"),
    makeTreeEntry("src/pages/index.astro"),
    makeTreeEntry("README.md"),
  ]);

  it("matches a simple glob", () => {
    const result = handleSearchFiles(ctx, { pattern: "src/app/*.tsx" });
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("src/app/home.tsx");
    expect(result.textResultForLlm).toContain("src/app/about.tsx");
    expect(result.textResultForLlm).not.toContain("src/pages/index.astro");
  });

  it("matches recursive globs", () => {
    const result = handleSearchFiles(ctx, { pattern: "**/*.tsx" });
    expect(result.textResultForLlm).toContain("src/app/home.tsx");
    expect(result.textResultForLlm).toContain("src/app/about.tsx");
  });

  it("returns a no-matches message when nothing matches", () => {
    const result = handleSearchFiles(ctx, { pattern: "**/*.py" });
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("No files matched");
  });

  it("truncates results to the configured limit", () => {
    const many: TreeEntry[] = Array.from({ length: 50 }, (_, i) =>
      makeTreeEntry(`src/file${i}.ts`),
    );
    const result = handleSearchFiles(
      makeContext(many),
      {
        pattern: "**/*.ts",
      },
      { maxResults: 5 },
    );
    expect(result.textResultForLlm).toContain("truncated at 5");
    // 5 matched files + header line
    const lineCount = result.textResultForLlm.split("\n").length;
    expect(lineCount).toBe(6);
  });

  it("fails on empty pattern", () => {
    const result = handleSearchFiles(ctx, { pattern: "" });
    expect(result.resultType).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// handleReadFile
// ---------------------------------------------------------------------------

describe("handleReadFile", () => {
  const entry = makeTreeEntry("src/app/routes.ts", { size: 500 });
  const ctx = makeContext([entry]);

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns file contents on success", async () => {
    const source = "export const routes = [];";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockResponse({
        name: "routes.ts",
        path: "src/app/routes.ts",
        sha: entry.sha,
        size: source.length,
        type: "file",
        content: base64Encode(source),
        encoding: "base64",
      }),
    );

    const result = await handleReadFile(ctx, { path: "src/app/routes.ts" });
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toBe(source);
  });

  it("reports file-not-found when path is not in the tree", async () => {
    const result = await handleReadFile(ctx, { path: "does/not/exist.ts" });
    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("not found");
    // No network call should have been attempted
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("surfaces rate-limit errors as structured failures", async () => {
    // Use retry-after: 1 so retry sleeps for only ~1s (within test timeout).
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse({ message: "API rate limit exceeded" }, 429, {
        "retry-after": "1",
      }),
    );

    const result = await handleReadFile(ctx, { path: "src/app/routes.ts" });
    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("rate limit");
  });

  it("surfaces 404 errors from the API as file-not-found failures", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockResponse({ message: "Not Found" }, 404),
    );

    const result = await handleReadFile(ctx, { path: "src/app/routes.ts" });
    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("not found");
  });

  it("does not double-prefix 'GitHub API error' wording on non-404 API errors", async () => {
    // 500 → GitHubApiError whose .message already starts with
    // "GitHub API error (500): ...". The tool failure text must NOT add a
    // second "GitHub API error" prefix on top of that.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse({ message: "Internal Server Error" }, 500),
    );

    const result = await handleReadFile(ctx, { path: "src/app/routes.ts" });
    expect(result.resultType).toBe("failure");
    // The contextual framing is present.
    expect(result.textResultForLlm).toContain("Error while reading");
    // The underlying message (which already contains the "GitHub API error"
    // prefix) is included exactly once — never duplicated.
    const occurrences = result.textResultForLlm.match(/GitHub API error/g);
    expect(occurrences).not.toBeNull();
    expect(occurrences!.length).toBe(1);
  });

  it("truncates very large files", async () => {
    const large = "a".repeat(10_000);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockResponse({
        name: "routes.ts",
        path: "src/app/routes.ts",
        sha: entry.sha,
        size: large.length,
        type: "file",
        content: base64Encode(large),
        encoding: "base64",
      }),
    );

    const result = await handleReadFile(
      ctx,
      { path: "src/app/routes.ts" },
      { maxBytes: 100 },
    );
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("bytes omitted");
    expect(result.textResultForLlm).toContain("[truncated:");
    expect(result.textResultForLlm.length).toBeLessThan(large.length);
  });

  it("reports truncation in UTF-8 bytes (not code units) for non-ASCII content", async () => {
    // Each Japanese character encodes as 3 bytes in UTF-8 but counts as 1
    // JS string code unit. Using a 900-byte payload with a 300-byte cap
    // would look like 300 chars of slack if we used `.length`, but the
    // real UTF-8 size is 900 bytes — the reported truncation must match.
    const ja = "あ".repeat(300); // 300 chars, 900 bytes in UTF-8
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockResponse({
        name: "routes.ts",
        path: "src/app/routes.ts",
        sha: entry.sha,
        size: Buffer.byteLength(ja, "utf8"),
        type: "file",
        content: base64Encode(ja),
        encoding: "base64",
      }),
    );

    const result = await handleReadFile(
      ctx,
      { path: "src/app/routes.ts" },
      { maxBytes: 300 },
    );
    expect(result.resultType).toBe("success");
    // 900 total bytes, head fits 100 chars × 3 bytes = 300 bytes,
    // so ~600 bytes should be reported as truncated.
    expect(result.textResultForLlm).toMatch(/600 bytes omitted/);
    expect(result.textResultForLlm).toContain("[truncated:");
    // And the head must not be split mid-codepoint.
    const headMatch = /^(あ+)/.exec(result.textResultForLlm);
    expect(headMatch).not.toBeNull();
    expect(headMatch![1]).toBe("あ".repeat(100));
  });

  it("does not truncate when total UTF-8 byte count is within the limit", async () => {
    // 50 'あ' chars = 150 bytes, which is below the 200-byte cap even
    // though we'd see 50 code units if we accidentally used .length.
    const ja = "あ".repeat(50);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockResponse({
        name: "routes.ts",
        path: "src/app/routes.ts",
        sha: entry.sha,
        size: Buffer.byteLength(ja, "utf8"),
        type: "file",
        content: base64Encode(ja),
        encoding: "base64",
      }),
    );

    const result = await handleReadFile(
      ctx,
      { path: "src/app/routes.ts" },
      { maxBytes: 200 },
    );
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toBe(ja);
    expect(result.textResultForLlm).not.toContain("bytes omitted");
    expect(result.textResultForLlm).not.toContain("[truncated:");
  });

  it("fails on empty path", async () => {
    const result = await handleReadFile(ctx, { path: "" });
    expect(result.resultType).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// handleGrepFiles
// ---------------------------------------------------------------------------

describe("handleGrepFiles", () => {
  const entries = [
    makeTreeEntry("src/home.tsx"),
    makeTreeEntry("src/login.tsx"),
    makeTreeEntry("src/README.md"),
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Mock a Contents-API response for a file path. */
  function mockContentsResponse(path: string, content: string): Response {
    return mockResponse({
      name: path.split("/").pop(),
      path,
      sha: "sha",
      size: content.length,
      type: "file",
      content: base64Encode(content),
      encoding: "base64",
    });
  }

  it("finds matches scoped by glob", async () => {
    const ctx = makeContext(entries);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (url: string) => {
        if (url.includes("/contents/src/home.tsx")) {
          return Promise.resolve(
            mockContentsResponse(
              "src/home.tsx",
              "import { useRouter } from 'next/router';\nrouter.push('/login');\nexport {};",
            ),
          );
        }
        if (url.includes("/contents/src/login.tsx")) {
          return Promise.resolve(
            mockContentsResponse("src/login.tsx", "// just a login page\n"),
          );
        }
        return Promise.resolve(mockContentsResponse("x", ""));
      },
    );

    const result = await handleGrepFiles(ctx, {
      query: "router.push",
      glob: "src/*.tsx",
    });
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("router.push");
    expect(result.textResultForLlm).toContain("src/home.tsx");
    expect(result.textResultForLlm).not.toContain("src/README.md");
  });

  it("returns a no-match message when nothing is found", async () => {
    const ctx = makeContext([makeTreeEntry("src/home.tsx")]);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockContentsResponse("src/home.tsx", "nothing interesting here"),
    );

    const result = await handleGrepFiles(ctx, { query: "router.push" });
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("No matches");
  });

  it("stops early on rate-limit during scan and surfaces partial results", async () => {
    const ctx = makeContext([makeTreeEntry("a.ts"), makeTreeEntry("b.ts")]);

    // 1st file: successful read.
    // 2nd file: rate-limit — retry-after: 1 keeps the test under the timeout.
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        mockContentsResponse("a.ts", "match router.push here\n"),
      )
      .mockResolvedValue(
        mockResponse({ message: "rate limited" }, 429, {
          "retry-after": "1",
        }),
      );

    const result = await handleGrepFiles(ctx, { query: "router.push" });
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("a.ts");
    expect(result.textResultForLlm).toContain("rate-limit");
  });

  it("truncates when too many matches are found", async () => {
    const ctx = makeContext([makeTreeEntry("src/big.ts")]);
    const line = "router.push('/x');";
    const content = Array.from({ length: 10 }, () => line).join("\n");
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockContentsResponse("src/big.ts", content),
    );

    const result = await handleGrepFiles(
      ctx,
      { query: "router.push" },
      { maxMatches: 3 },
    );
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("Results truncated at 3");
  });

  it("skips unreadable files (non-rate-limit errors) and continues", async () => {
    const ctx = makeContext([makeTreeEntry("skip.ts"), makeTreeEntry("ok.ts")]);

    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(
        mockContentsResponse("ok.ts", "router.push('/home');\n"),
      );

    const result = await handleGrepFiles(ctx, { query: "router.push" });
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("ok.ts");
    expect(result.textResultForLlm).not.toContain("skip.ts");
  });

  it("fails on empty query", async () => {
    const ctx = makeContext([makeTreeEntry("a.ts")]);
    const result = await handleGrepFiles(ctx, { query: "" });
    expect(result.resultType).toBe("failure");
  });

  it("returns a clear message when the glob matches no files", async () => {
    const ctx = makeContext([makeTreeEntry("src/home.tsx")]);
    const result = await handleGrepFiles(ctx, {
      query: "x",
      glob: "**/*.py",
    });
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("No files matched glob");
  });

  it("skips files larger than GREP_MAX_FILE_BYTES without fetching them", async () => {
    // 1 MB > 512 KB limit → must be skipped (no network call for it).
    const hugeEntry = makeTreeEntry("bundle.js", { size: 1_048_576 });
    const smallEntry = makeTreeEntry("src/home.tsx", { size: 200 });
    const ctx = makeContext([hugeEntry, smallEntry]);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (url: string) => {
        if (url.includes("/contents/src/home.tsx")) {
          return Promise.resolve(
            mockContentsResponse("src/home.tsx", "router.push('/next');\n"),
          );
        }
        // The huge file must never be fetched.
        throw new Error(`unexpected fetch: ${url}`);
      },
    );

    const result = await handleGrepFiles(ctx, { query: "router.push" });
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("src/home.tsx");
    expect(result.textResultForLlm).not.toContain("bundle.js");
    // The header mentions the skip so the model can see why results are thin.
    expect(result.textResultForLlm).toContain("1 large file skipped");
    // Fetch must have been called only for the small file, never for the huge blob.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetchedUrls.some((u) => u.includes("/contents/bundle.js"))).toBe(
      false,
    );
  });

  it("reports skipped-large-file count in the no-match header too", async () => {
    const hugeEntry = makeTreeEntry("giant.js", { size: 10_000_000 });
    const smallEntry = makeTreeEntry("tiny.ts", { size: 10 });
    const ctx = makeContext([hugeEntry, smallEntry]);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockContentsResponse("tiny.ts", "nothing to see here\n"),
    );

    const result = await handleGrepFiles(ctx, { query: "router.push" });
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("No matches");
    expect(result.textResultForLlm).toContain("1 large file skipped");
  });
});

// ---------------------------------------------------------------------------
// Argument coercion
// ---------------------------------------------------------------------------

describe("argument coercion", () => {
  it("coerceReadFileArgs extracts string path", () => {
    expect(coerceReadFileArgs({ path: "a.ts" })).toEqual({ path: "a.ts" });
    expect(coerceReadFileArgs({ path: 42 })).toEqual({ path: "" });
    expect(coerceReadFileArgs(null)).toEqual({ path: "" });
    expect(coerceReadFileArgs(undefined)).toEqual({ path: "" });
  });

  it("coerceSearchFilesArgs extracts string pattern", () => {
    expect(coerceSearchFilesArgs({ pattern: "**/*.ts" })).toEqual({
      pattern: "**/*.ts",
    });
    expect(coerceSearchFilesArgs({})).toEqual({ pattern: "" });
  });

  it("coerceGrepFilesArgs handles optional glob", () => {
    expect(coerceGrepFilesArgs({ query: "x", glob: "*.ts" })).toEqual({
      query: "x",
      glob: "*.ts",
    });
    expect(coerceGrepFilesArgs({ query: "x" })).toEqual({
      query: "x",
      glob: undefined,
    });
    expect(coerceGrepFilesArgs({ query: "x", glob: 5 })).toEqual({
      query: "x",
      glob: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// buildRepoTools
// ---------------------------------------------------------------------------

describe("buildRepoTools", () => {
  const ctx = makeContext([makeTreeEntry("src/app.ts")]);

  it("returns exactly three tools with the expected names", () => {
    const tools = buildRepoTools(ctx);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "grepFiles",
      "readFile",
      "searchFiles",
    ]);
  });

  it("each tool has a description and a JSON schema", () => {
    const tools = buildRepoTools(ctx);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(tool.handler).toBeTypeOf("function");
    }
  });

  it("tool handlers coerce unknown args to typed shapes", async () => {
    const tools = buildRepoTools(ctx);
    const searchTool = tools.find((t) => t.name === "searchFiles")!;

    const invocation = {
      sessionId: "s",
      toolCallId: "t",
      toolName: "searchFiles",
    };

    // Pass raw unknown args (simulating what the SDK provides).
    const result = await searchTool.handler({ pattern: "**/*.ts" }, invocation);

    expect(result).toMatchObject({ resultType: "success" });
  });

  it("readFile handler rejects missing files without calling fetch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    try {
      const tools = buildRepoTools(ctx);
      const readFileTool = tools.find((t) => t.name === "readFile")!;
      const result = await readFileTool.handler(
        { path: "nope.ts" },
        { sessionId: "s", toolCallId: "t", toolName: "readFile" },
      );
      expect(result).toMatchObject({ resultType: "failure" });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
