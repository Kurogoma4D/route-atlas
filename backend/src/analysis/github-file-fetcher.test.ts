import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchFileTree,
  filterFilesByPatterns,
  fetchFileContents,
  fetchSingleFileContent,
  fetchViaBlobApi,
  decodeBase64Content,
  githubFetch,
  GitHubRateLimitError,
  GitHubApiError,
  type TreeEntry,
  type TreeResponse,
  type ContentsResponse,
  type BlobResponse,
} from "./github-file-fetcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = "gho_test_token";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("github-file-fetcher", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // decodeBase64Content
  // -------------------------------------------------------------------------
  describe("decodeBase64Content", () => {
    it("decodes a simple base64 string", () => {
      const encoded = base64Encode("hello world");
      expect(decodeBase64Content(encoded)).toBe("hello world");
    });

    it("handles base64 with line breaks (as GitHub returns)", () => {
      const encoded = base64Encode("line 1\nline 2\nline 3");
      // Insert line breaks to simulate GitHub's output
      const withLineBreaks = encoded.match(/.{1,20}/g)!.join("\n");
      expect(decodeBase64Content(withLineBreaks)).toBe(
        "line 1\nline 2\nline 3",
      );
    });
  });

  // -------------------------------------------------------------------------
  // githubFetch — rate limit / retry
  // -------------------------------------------------------------------------
  describe("githubFetch", () => {
    it("returns parsed JSON on success", async () => {
      const body = { data: "ok" };
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(body));

      const result = await githubFetch<typeof body>(
        "https://api.github.com/test",
        TOKEN,
      );
      expect(result).toEqual(body);
    });

    it("sends correct authorization headers", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse({}));

      await githubFetch("https://api.github.com/test", TOKEN);

      expect(fetch).toHaveBeenCalledWith("https://api.github.com/test", {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    });

    it("retries on 429 with retry-after header", async () => {
      const noopSleep = vi.fn().mockResolvedValue(undefined);

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          mockFetchResponse({ message: "rate limit" }, 429, {
            "retry-after": "1",
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ ok: true }));

      const result = await githubFetch<{ ok: boolean }>(
        "https://api.github.com/test",
        TOKEN,
        3,
        noopSleep,
      );

      expect(result).toEqual({ ok: true });
      expect(noopSleep).toHaveBeenCalledWith(1000);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("retries on 403 with x-ratelimit-remaining 0", async () => {
      const noopSleep = vi.fn().mockResolvedValue(undefined);
      const futureEpoch = Math.floor(Date.now() / 1000) + 5;

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          mockFetchResponse({ message: "rate limit" }, 403, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(futureEpoch),
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ ok: true }));

      const result = await githubFetch<{ ok: boolean }>(
        "https://api.github.com/test",
        TOKEN,
        3,
        noopSleep,
      );

      expect(result).toEqual({ ok: true });
      expect(noopSleep).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("uses exponential backoff when no retry headers present", async () => {
      const noopSleep = vi.fn().mockResolvedValue(undefined);

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          mockFetchResponse({ message: "rate limit" }, 429),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ message: "rate limit" }, 429),
        )
        .mockResolvedValueOnce(mockFetchResponse({ ok: true }));

      await githubFetch<{ ok: boolean }>(
        "https://api.github.com/test",
        TOKEN,
        3,
        noopSleep,
      );

      // 1000 * 2^0 = 1000, 1000 * 2^1 = 2000
      expect(noopSleep).toHaveBeenNthCalledWith(1, 1000);
      expect(noopSleep).toHaveBeenNthCalledWith(2, 2000);
    });

    it("throws GitHubRateLimitError after all retries exhausted", async () => {
      const noopSleep = vi.fn().mockResolvedValue(undefined);

      vi.mocked(fetch).mockResolvedValue(
        mockFetchResponse({ message: "rate limit" }, 429),
      );

      await expect(
        githubFetch("https://api.github.com/test", TOKEN, 2, noopSleep),
      ).rejects.toThrow(GitHubRateLimitError);

      // 3 attempts total (initial + 2 retries)
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("throws GitHubApiError on 403 that is not a rate limit (x-ratelimit-remaining != 0)", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        mockFetchResponse({ message: "too large" }, 403, {
          "x-ratelimit-remaining": "42",
        }),
      );

      await expect(
        githubFetch("https://api.github.com/test", TOKEN),
      ).rejects.toThrow(GitHubApiError);

      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("throws GitHubApiError on non-rate-limit errors without retrying", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        mockFetchResponse({ message: "Not Found" }, 404),
      );

      await expect(
        githubFetch("https://api.github.com/test", TOKEN),
      ).rejects.toThrow(GitHubApiError);

      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // fetchFileTree
  // -------------------------------------------------------------------------
  describe("fetchFileTree", () => {
    it("fetches and returns blob entries only", async () => {
      const treeResponse: TreeResponse = {
        sha: "abc123",
        url: "https://api.github.com/repos/owner/repo/git/trees/abc123",
        truncated: false,
        tree: [
          makeTreeEntry("src/index.ts"),
          {
            path: "src",
            mode: "040000",
            type: "tree",
            sha: "dir_sha",
            url: "https://api.github.com/repos/owner/repo/git/trees/dir_sha",
          },
          makeTreeEntry("package.json"),
        ],
      };

      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(treeResponse));

      const result = await fetchFileTree("owner", "repo", "main", TOKEN);

      expect(result.truncated).toBe(false);
      expect(result.files).toHaveLength(2);
      expect(result.files.map((f) => f.path)).toEqual([
        "src/index.ts",
        "package.json",
      ]);
    });

    it("reports truncated flag from the API", async () => {
      const treeResponse: TreeResponse = {
        sha: "abc123",
        url: "https://api.github.com/repos/owner/repo/git/trees/abc123",
        truncated: true,
        tree: [makeTreeEntry("README.md")],
      };

      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(treeResponse));

      const result = await fetchFileTree("owner", "repo", "main", TOKEN);
      expect(result.truncated).toBe(true);
    });

    it("calls the correct API URL", async () => {
      const treeResponse: TreeResponse = {
        sha: "abc123",
        url: "",
        truncated: false,
        tree: [],
      };

      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(treeResponse));

      await fetchFileTree("myorg", "myrepo", "develop", TOKEN);

      expect(fetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/myorg/myrepo/git/trees/develop?recursive=1",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${TOKEN}`,
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // filterFilesByPatterns
  // -------------------------------------------------------------------------
  describe("filterFilesByPatterns", () => {
    const allFiles: TreeEntry[] = [
      makeTreeEntry("app/page.tsx"),
      makeTreeEntry("app/layout.tsx"),
      makeTreeEntry("app/dashboard/page.tsx"),
      makeTreeEntry("app/dashboard/loading.tsx"),
      makeTreeEntry("src/utils/helper.ts"),
      makeTreeEntry("package.json"),
      makeTreeEntry("pages/index.tsx"),
      makeTreeEntry("pages/about.tsx"),
      makeTreeEntry("src/routes/home.routes.tsx"),
      makeTreeEntry("src/router.tsx"),
    ];

    it("filters by Next.js App Router patterns", () => {
      const patterns = ["app/**/page.{tsx,jsx,ts,js}", "app/**/layout.*"];
      const result = filterFilesByPatterns(allFiles, patterns);

      expect(result.map((f) => f.path)).toEqual([
        "app/page.tsx",
        "app/layout.tsx",
        "app/dashboard/page.tsx",
      ]);
    });

    it("filters by Next.js Pages Router patterns", () => {
      const patterns = ["pages/**/*.{tsx,jsx,ts,js}"];
      const result = filterFilesByPatterns(allFiles, patterns);

      expect(result.map((f) => f.path)).toEqual([
        "pages/index.tsx",
        "pages/about.tsx",
      ]);
    });

    it("filters by React Router patterns", () => {
      const patterns = [
        "src/**/routes.{tsx,jsx,ts,js}",
        "src/**/router.{tsx,jsx,ts,js}",
        "src/**/*.routes.{tsx,jsx,ts,js}",
      ];
      const result = filterFilesByPatterns(allFiles, patterns);

      expect(result.map((f) => f.path)).toEqual([
        "src/routes/home.routes.tsx",
        "src/router.tsx",
      ]);
    });

    it("returns empty array when no patterns provided", () => {
      const result = filterFilesByPatterns(allFiles, []);
      expect(result).toEqual([]);
    });

    it("returns empty array when no files match", () => {
      const result = filterFilesByPatterns(allFiles, ["**/*.vue"]);
      expect(result).toEqual([]);
    });

    it("handles multiple overlapping patterns without duplicates", () => {
      const patterns = ["app/**/*.tsx", "app/**/page.tsx"];
      const result = filterFilesByPatterns(allFiles, patterns);

      // filter preserves order, no duplicates since filter iterates files once
      const paths = result.map((f) => f.path);
      expect(paths).toEqual([
        "app/page.tsx",
        "app/layout.tsx",
        "app/dashboard/page.tsx",
        "app/dashboard/loading.tsx",
      ]);
      // No duplicates
      expect(new Set(paths).size).toBe(paths.length);
    });
  });

  // -------------------------------------------------------------------------
  // fetchSingleFileContent
  // -------------------------------------------------------------------------
  describe("fetchSingleFileContent", () => {
    it("fetches file content via Contents API for small files", async () => {
      const fileContent = "export const x = 42;";
      const contentsResponse: ContentsResponse = {
        name: "index.ts",
        path: "src/index.ts",
        sha: "file_sha",
        size: 100,
        type: "file",
        content: base64Encode(fileContent),
        encoding: "base64",
      };

      vi.mocked(fetch).mockResolvedValueOnce(
        mockFetchResponse(contentsResponse),
      );

      const file = makeTreeEntry("src/index.ts", { size: 100 });
      const result = await fetchSingleFileContent("owner", "repo", file, TOKEN);

      expect(result).toBe(fileContent);
    });

    it("uses Blob API for files exceeding 1MB", async () => {
      const fileContent = "large file content";
      const blobResponse: BlobResponse = {
        sha: "blob_sha",
        content: base64Encode(fileContent),
        encoding: "base64",
        size: 2_000_000,
      };

      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(blobResponse));

      const file = makeTreeEntry("src/big-file.ts", { size: 2_000_000 });
      const result = await fetchSingleFileContent("owner", "repo", file, TOKEN);

      expect(result).toBe(fileContent);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/git/blobs/"),
        expect.any(Object),
      );
    });

    it("falls back to Blob API when Contents API returns 403", async () => {
      const fileContent = "fallback content";

      // Contents API returns 403 (not a rate limit — x-ratelimit-remaining is not "0")
      vi.mocked(fetch).mockResolvedValueOnce(
        mockFetchResponse({ message: "too large" }, 403, {
          "x-ratelimit-remaining": "42",
        }),
      );
      // Blob API succeeds
      vi.mocked(fetch).mockResolvedValueOnce(
        mockFetchResponse({
          sha: "blob_sha",
          content: base64Encode(fileContent),
          encoding: "base64",
          size: 500_000,
        } satisfies BlobResponse),
      );

      const file = makeTreeEntry("src/medium-file.ts", { size: 500_000 });
      const result = await fetchSingleFileContent("owner", "repo", file, TOKEN);

      expect(result).toBe(fileContent);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("includes ref query parameter when provided", async () => {
      const contentsResponse: ContentsResponse = {
        name: "index.ts",
        path: "src/index.ts",
        sha: "file_sha",
        size: 100,
        type: "file",
        content: base64Encode("content"),
        encoding: "base64",
      };

      vi.mocked(fetch).mockResolvedValueOnce(
        mockFetchResponse(contentsResponse),
      );

      const file = makeTreeEntry("src/index.ts", { size: 100 });
      await fetchSingleFileContent("owner", "repo", file, TOKEN, "develop");

      expect(fetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/owner/repo/contents/src/index.ts?ref=develop",
        expect.any(Object), // encodeURIComponent is no-op for simple paths
      );
    });
  });

  // -------------------------------------------------------------------------
  // fetchViaBlobApi
  // -------------------------------------------------------------------------
  describe("fetchViaBlobApi", () => {
    it("fetches and decodes base64 blob content", async () => {
      const content = "blob file content";
      const blobResponse: BlobResponse = {
        sha: "blob_sha",
        content: base64Encode(content),
        encoding: "base64",
        size: content.length,
      };

      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(blobResponse));

      const result = await fetchViaBlobApi("owner", "repo", "blob_sha", TOKEN);
      expect(result).toBe(content);
    });

    it("returns utf-8 content as-is", async () => {
      const content = "utf-8 content";
      const blobResponse: BlobResponse = {
        sha: "blob_sha",
        content,
        encoding: "utf-8",
        size: content.length,
      };

      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(blobResponse));

      const result = await fetchViaBlobApi("owner", "repo", "blob_sha", TOKEN);
      expect(result).toBe(content);
    });

    it("calls the correct Blob API URL", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        mockFetchResponse({
          sha: "abc",
          content: base64Encode("x"),
          encoding: "base64",
          size: 1,
        } satisfies BlobResponse),
      );

      await fetchViaBlobApi("owner", "repo", "abc123sha", TOKEN);

      expect(fetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/owner/repo/git/blobs/abc123sha",
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // fetchFileContents
  // -------------------------------------------------------------------------
  describe("fetchFileContents", () => {
    it("fetches contents for multiple files", async () => {
      const files = [
        makeTreeEntry("src/a.ts", { size: 100 }),
        makeTreeEntry("src/b.ts", { size: 200 }),
      ];

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          mockFetchResponse({
            name: "a.ts",
            path: "src/a.ts",
            sha: "sha_a",
            size: 100,
            type: "file",
            content: base64Encode("file a"),
            encoding: "base64",
          } satisfies ContentsResponse),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({
            name: "b.ts",
            path: "src/b.ts",
            sha: "sha_b",
            size: 200,
            type: "file",
            content: base64Encode("file b"),
            encoding: "base64",
          } satisfies ContentsResponse),
        );

      const results = await fetchFileContents("owner", "repo", files, TOKEN);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ path: "src/a.ts", content: "file a" });
      expect(results[1]).toEqual({ path: "src/b.ts", content: "file b" });
    });

    it("handles a mix of small and large files", async () => {
      const files = [
        makeTreeEntry("src/small.ts", { size: 100 }),
        makeTreeEntry("src/large.ts", { size: 2_000_000 }),
      ];

      // Small file via Contents API
      vi.mocked(fetch).mockResolvedValueOnce(
        mockFetchResponse({
          name: "small.ts",
          path: "src/small.ts",
          sha: "sha_small",
          size: 100,
          type: "file",
          content: base64Encode("small content"),
          encoding: "base64",
        } satisfies ContentsResponse),
      );

      // Large file via Blob API
      vi.mocked(fetch).mockResolvedValueOnce(
        mockFetchResponse({
          sha: "sha_large",
          content: base64Encode("large content"),
          encoding: "base64",
          size: 2_000_000,
        } satisfies BlobResponse),
      );

      const results = await fetchFileContents("owner", "repo", files, TOKEN);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        path: "src/small.ts",
        content: "small content",
      });
      expect(results[1]).toEqual({
        path: "src/large.ts",
        content: "large content",
      });
    });
  });
});
