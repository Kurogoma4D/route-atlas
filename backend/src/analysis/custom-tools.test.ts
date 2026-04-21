import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createCustomTools,
  formatToolError,
  type CustomToolsOptions,
} from "./custom-tools.js";
import {
  GitHubApiError,
  GitHubRateLimitError,
  type TreeEntry,
} from "./github-file-fetcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(path: string, overrides?: Partial<TreeEntry>): TreeEntry {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha: `sha_${path.replace(/[/.]/g, "_")}`,
    size: 500,
    url: `https://api.github.com/repos/o/r/git/blobs/sha_${path}`,
    ...overrides,
  };
}

function base64(text: string): string {
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

const INVOCATION = {
  sessionId: "s1",
  toolCallId: "t1",
  toolName: "test",
  arguments: {},
};

const BASE_OPTIONS: CustomToolsOptions = {
  owner: "octo",
  repo: "cat",
  branch: "main",
  token: "gho_test",
  allFiles: [
    makeEntry("src/app/home.tsx"),
    makeEntry("src/app/login.tsx"),
    makeEntry("src/lib/util.ts"),
    makeEntry("README.md"),
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("custom-tools", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // formatToolError
  // -------------------------------------------------------------------------
  describe("formatToolError", () => {
    it("formats rate-limit errors with retry info", () => {
      const err = new GitHubRateLimitError(42);
      expect(formatToolError(err)).toContain("rate limit");
      expect(formatToolError(err)).toContain("42 seconds");
    });

    it("formats 404 API errors as not-found", () => {
      const err = new GitHubApiError(404, "Not Found");
      expect(formatToolError(err)).toBe(
        "Error: File not found in the repository.",
      );
    });

    it("formats generic API errors with status", () => {
      const err = new GitHubApiError(500, "internal");
      expect(formatToolError(err)).toBe("Error: GitHub API returned 500.");
    });

    it("formats generic Error instances", () => {
      expect(formatToolError(new Error("boom"))).toBe("Error: boom");
    });

    it("formats unknown throwables", () => {
      expect(formatToolError("string")).toBe(
        "Error: Unknown failure while calling GitHub API.",
      );
    });
  });

  // -------------------------------------------------------------------------
  // createCustomTools — shape
  // -------------------------------------------------------------------------
  describe("createCustomTools", () => {
    it("returns three tools with the expected names", () => {
      const tools = createCustomTools(BASE_OPTIONS);
      expect(tools.map((t) => t.name)).toEqual([
        "readFile",
        "searchFiles",
        "grepFiles",
      ]);
    });

    it("declares JSON schema parameters for every tool", () => {
      const tools = createCustomTools(BASE_OPTIONS);
      for (const t of tools) {
        expect(t.parameters).toBeDefined();
        const params = t.parameters as Record<string, unknown>;
        expect(params.type).toBe("object");
      }
    });
  });

  // -------------------------------------------------------------------------
  // readFile
  // -------------------------------------------------------------------------
  describe("readFile tool", () => {
    it("returns the decoded file contents on success", async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          name: "home.tsx",
          path: "src/app/home.tsx",
          sha: "sha_x",
          size: 11,
          type: "file",
          content: base64("hello world"),
          encoding: "base64",
        }),
      );

      const [readFile] = createCustomTools(BASE_OPTIONS);
      const result = await readFile.handler(
        { path: "src/app/home.tsx" },
        INVOCATION,
      );

      expect(result).toBe("hello world");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns a not-found message for unknown paths without calling fetch", async () => {
      const [readFile] = createCustomTools(BASE_OPTIONS);
      const result = await readFile.handler(
        { path: "does/not/exist.ts" },
        INVOCATION,
      );

      expect(result).toBe("Error: File not found.");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects arguments missing the path field", async () => {
      const [readFile] = createCustomTools(BASE_OPTIONS);
      const result = await readFile.handler({}, INVOCATION);
      expect(typeof result).toBe("string");
      expect(result as string).toMatch(/path/i);
    });

    it("rejects empty string path", async () => {
      const [readFile] = createCustomTools(BASE_OPTIONS);
      const result = await readFile.handler({ path: "" }, INVOCATION);
      expect(typeof result).toBe("string");
      expect(result as string).toMatch(/path/i);
    });

    it("rejects non-object arguments", async () => {
      const [readFile] = createCustomTools(BASE_OPTIONS);
      const result = await readFile.handler("oops" as unknown, INVOCATION);
      expect(result).toBe("Error: invalid arguments.");
    });

    it("converts GitHub rate-limit responses to a friendly string", async () => {
      // `githubFetch` retries once on 429, so both mock responses must
      // return rate-limited to exhaust retries. `retry-after: 0` makes
      // the back-off sleep a no-op.
      const rateLimited = () =>
        mockFetchResponse({ message: "rate-limited" }, 429, {
          "retry-after": "0",
        });
      fetchMock.mockResolvedValueOnce(rateLimited());
      fetchMock.mockResolvedValueOnce(rateLimited());

      const [readFile] = createCustomTools(BASE_OPTIONS);
      const result = await readFile.handler(
        { path: "src/app/home.tsx" },
        INVOCATION,
      );

      expect(typeof result).toBe("string");
      expect(result as string).toContain("rate limit");
    });

    it("truncates very large file contents", async () => {
      const big = "a".repeat(200_000);
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          name: "home.tsx",
          path: "src/app/home.tsx",
          sha: "sha_x",
          size: big.length,
          type: "file",
          content: base64(big),
          encoding: "base64",
        }),
      );

      const [readFile] = createCustomTools({
        ...BASE_OPTIONS,
        maxFileBytes: 100,
      });
      const result = (await readFile.handler(
        { path: "src/app/home.tsx" },
        INVOCATION,
      )) as string;

      expect(result.length).toBeLessThan(big.length);
      expect(result).toContain("[truncated");
    });

    it("caches repeated readFile calls for the same path", async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({
          name: "home.tsx",
          path: "src/app/home.tsx",
          sha: "abc",
          size: 11,
          type: "file",
          content: base64("hello world"),
          encoding: "base64",
        }),
      );

      const [readFile] = createCustomTools(BASE_OPTIONS);
      const r1 = await readFile.handler({ path: "src/app/home.tsx" }, INVOCATION);
      const r2 = await readFile.handler({ path: "src/app/home.tsx" }, INVOCATION);

      expect(r1).toBe("hello world");
      expect(r2).toBe("hello world");
      // Network should be hit only once despite two calls.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("blocks sensitive files and returns not-found without calling fetch", async () => {
      const sensitiveFiles = [
        ".env",
        ".env.production",
        "config/credentials.json",
        "id_rsa",
        "server.key",
        "cert.pem",
        "secrets/api_key.txt",
      ];
      const [readFile] = createCustomTools({
        ...BASE_OPTIONS,
        allFiles: [
          ...BASE_OPTIONS.allFiles,
          ...sensitiveFiles.map(makeEntry),
        ],
      });
      for (const path of sensitiveFiles) {
        const result = await readFile.handler({ path }, INVOCATION);
        expect(result).toBe("Error: File not found.");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("evicts failed promises from the cache so transient errors can be retried", async () => {
      fetchMock
        .mockResolvedValueOnce(mockFetchResponse({ message: "server error" }, 500))
        .mockResolvedValueOnce(
          mockFetchResponse({
            name: "home.tsx",
            path: "src/app/home.tsx",
            sha: "abc",
            size: 5,
            type: "file",
            content: base64("retry"),
            encoding: "base64",
          }),
        );

      const [readFile] = createCustomTools(BASE_OPTIONS);
      const r1 = await readFile.handler({ path: "src/app/home.tsx" }, INVOCATION);
      expect(r1).toContain("Error:");

      const r2 = await readFile.handler({ path: "src/app/home.tsx" }, INVOCATION);
      expect(r2).toBe("retry");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // searchFiles
  // -------------------------------------------------------------------------
  describe("searchFiles tool", () => {
    it("returns matching paths newline-separated", async () => {
      const [, searchFiles] = createCustomTools(BASE_OPTIONS);
      const result = await searchFiles.handler(
        { pattern: "src/**/*.tsx" },
        INVOCATION,
      );

      const lines = (result as string).split("\n");
      expect(lines).toContain("src/app/home.tsx");
      expect(lines).toContain("src/app/login.tsx");
      expect(lines).not.toContain("src/lib/util.ts");
    });

    it("returns a 'no files matched' marker when empty", async () => {
      const [, searchFiles] = createCustomTools(BASE_OPTIONS);
      const result = await searchFiles.handler(
        { pattern: "does/not/*.xyz" },
        INVOCATION,
      );
      expect(result).toBe("(no files matched)");
    });

    it("caps results to maxSearchResults", async () => {
      const [, searchFiles] = createCustomTools({
        ...BASE_OPTIONS,
        maxSearchResults: 2,
      });
      const result = await searchFiles.handler({ pattern: "**/*" }, INVOCATION);
      expect((result as string).split("\n")).toHaveLength(2);
    });

    it("rejects missing pattern argument", async () => {
      const [, searchFiles] = createCustomTools(BASE_OPTIONS);
      const result = await searchFiles.handler({}, INVOCATION);
      expect(result as string).toMatch(/pattern/i);
    });

    it("rejects non-object arguments", async () => {
      const [, searchFiles] = createCustomTools(BASE_OPTIONS);
      const result = await searchFiles.handler("oops", INVOCATION);
      expect(result).toBe("Error: invalid arguments.");
    });

    it("does NOT hit the network", async () => {
      const [, searchFiles] = createCustomTools(BASE_OPTIONS);
      await searchFiles.handler({ pattern: "**/*.ts" }, INVOCATION);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("excludes sensitive files from results", async () => {
      const [, searchFiles] = createCustomTools({
        ...BASE_OPTIONS,
        allFiles: [
          ...BASE_OPTIONS.allFiles,
          makeEntry(".env"),
          makeEntry("config/credentials.json"),
          makeEntry("keys/id_rsa"),
        ],
      });
      const result = (await searchFiles.handler(
        { pattern: "**/*" },
        INVOCATION,
      )) as string;
      const lines = result.split("\n");
      expect(lines).not.toContain(".env");
      expect(lines).not.toContain("config/credentials.json");
      expect(lines).not.toContain("keys/id_rsa");
    });
  });

  // -------------------------------------------------------------------------
  // grepFiles
  // -------------------------------------------------------------------------
  describe("grepFiles tool", () => {
    it("calls the GitHub code-search API and returns paths", async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          total_count: 2,
          incomplete_results: false,
          items: [{ path: "src/app/home.tsx" }, { path: "src/app/login.tsx" }],
        }),
      );

      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      const result = (await grepFiles.handler(
        { query: "useNavigate" },
        INVOCATION,
      )) as string;

      expect(result.split("\n")).toEqual([
        "src/app/home.tsx",
        "src/app/login.tsx",
      ]);
      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/search/code");
      expect(calledUrl).toContain("repo%3Aocto%2Fcat");
      expect(calledUrl).toContain("useNavigate");
    });

    it("filters results by the optional glob", async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          total_count: 2,
          incomplete_results: false,
          items: [{ path: "src/app/home.tsx" }, { path: "README.md" }],
        }),
      );

      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      const result = (await grepFiles.handler(
        { query: "hi", glob: "**/*.tsx" },
        INVOCATION,
      )) as string;

      expect(result).toBe("src/app/home.tsx");
    });

    it("returns a marker when the API yields no matches", async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          total_count: 0,
          incomplete_results: false,
          items: [],
        }),
      );

      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      const result = await grepFiles.handler(
        { query: "nothing_here" },
        INVOCATION,
      );
      expect(result).toBe("(no matches)");
    });

    it("surfaces rate-limit errors as text", async () => {
      const rateLimited = () =>
        mockFetchResponse({ message: "rate-limited" }, 403, {
          "x-ratelimit-remaining": "0",
          "retry-after": "0",
        });
      fetchMock.mockResolvedValueOnce(rateLimited());
      fetchMock.mockResolvedValueOnce(rateLimited());

      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      const result = await grepFiles.handler({ query: "anything" }, INVOCATION);

      expect(typeof result).toBe("string");
      expect(result as string).toContain("rate limit");
    });

    it("surfaces non-rate-limit API errors as text", async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ message: "nope" }, 422),
      );

      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      const result = await grepFiles.handler({ query: "x" }, INVOCATION);

      expect(result as string).toContain("GitHub API returned 422");
    });

    it("rejects missing query argument", async () => {
      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      const result = await grepFiles.handler({}, INVOCATION);
      expect(result as string).toMatch(/query/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects non-object arguments", async () => {
      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      const result = await grepFiles.handler("oops" as unknown, INVOCATION);
      expect(result).toBe("Error: invalid arguments.");
    });

    it("returns a marker when glob filters all API results to zero matches", async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          total_count: 2,
          incomplete_results: false,
          items: [{ path: "src/app/home.tsx" }, { path: "README.md" }],
        }),
      );

      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      const result = await grepFiles.handler(
        { query: "hello", glob: "**/*.py" },
        INVOCATION,
      );
      expect(result).toBe("(no matches)");
    });

    it("strips injected repo: qualifiers from the query to prevent scope bypass", async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          total_count: 0,
          incomplete_results: false,
          items: [],
        }),
      );

      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      await grepFiles.handler(
        { query: "secret repo:attacker/private-repo" },
        INVOCATION,
      );

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      const decodedUrl = decodeURIComponent(calledUrl);
      // The injected repo qualifier must be stripped; only the server-enforced one remains.
      expect(decodedUrl).not.toContain("repo:attacker/private-repo");
      expect(decodedUrl).toContain("repo:octo/cat");
    });

    it("returns an error when query is empty after stripping qualifiers", async () => {
      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      const result = await grepFiles.handler(
        { query: "repo:attacker/private-repo" },
        INVOCATION,
      );
      expect(result as string).toContain("Error:");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("caches repeated grepFiles calls for the same query", async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({
          total_count: 1,
          incomplete_results: false,
          items: [{ path: "src/app/home.tsx" }],
        }),
      );

      const [, , grepFiles] = createCustomTools(BASE_OPTIONS);
      const r1 = await grepFiles.handler({ query: "useNavigate" }, INVOCATION);
      const r2 = await grepFiles.handler({ query: "useNavigate" }, INVOCATION);

      expect(r1).toBe("src/app/home.tsx");
      expect(r2).toBe("src/app/home.tsx");
      // Network should be hit only once despite two identical queries.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("excludes sensitive file paths returned by the GitHub Search API", async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          total_count: 3,
          incomplete_results: false,
          items: [
            { path: "src/app/home.tsx" },
            { path: ".env" },
            { path: "config/credentials.json" },
          ],
        }),
      );

      const [, , grepFiles] = createCustomTools({
        ...BASE_OPTIONS,
        allFiles: [
          ...BASE_OPTIONS.allFiles,
          makeEntry(".env"),
          makeEntry("config/credentials.json"),
        ],
      });
      const result = (await grepFiles.handler(
        { query: "API_KEY" },
        INVOCATION,
      )) as string;

      expect(result).toBe("src/app/home.tsx");
      expect(result).not.toContain(".env");
      expect(result).not.toContain("credentials");
    });
  });
});
