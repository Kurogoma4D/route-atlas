import { describe, it, expect, vi } from "vitest";
import { createFileTools } from "./file-tools.js";
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
    size: 200,
    url: `https://api.github.com/blobs/${path}`,
    ...overrides,
  };
}

const BASE_FILES: TreeEntry[] = [
  makeEntry("src/app/home.tsx"),
  makeEntry("src/app/login.tsx"),
  makeEntry("src/app/dashboard.tsx"),
  makeEntry("src/components/button.tsx"),
  makeEntry("README.md"),
];

function stubFetcher(
  contents: Record<string, string>,
): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (
      _owner: string,
      _repo: string,
      entry: TreeEntry,
      _token: string,
    ): Promise<string> => {
      const content = contents[entry.path];
      if (content === undefined) {
        throw new GitHubApiError(404, `Not Found: ${entry.path}`);
      }
      return content;
    },
  );
}

function toolByName(
  tools: ReturnType<typeof createFileTools>,
  name: string,
): (typeof tools)[number] {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool '${name}' not found`);
  return tool;
}

const MOCK_INVOCATION = {
  sessionId: "s",
  toolCallId: "t",
  toolName: "unused",
  arguments: undefined,
};

async function callTool(
  tool: ReturnType<typeof createFileTools>[number],
  args: unknown,
): Promise<string> {
  const result = await tool.handler(args, {
    ...MOCK_INVOCATION,
    toolName: tool.name,
    arguments: args,
  });
  return typeof result === "string" ? result : JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createFileTools", () => {
  const baseContext = {
    owner: "acme",
    repo: "app",
    branch: "main",
    token: "gho_test",
    files: BASE_FILES,
  };

  it("exposes exactly readFile, searchFiles, grepFiles", () => {
    const tools = createFileTools(baseContext, {
      fetchSingleFile: stubFetcher({}),
    });
    expect(tools.map((t) => t.name).sort()).toEqual([
      "grepFiles",
      "readFile",
      "searchFiles",
    ]);
  });

  // -------------------------------------------------------------------------
  // readFile
  // -------------------------------------------------------------------------
  describe("readFile", () => {
    it("fetches a file's contents and includes them in the result", async () => {
      const fetcher = stubFetcher({
        "src/app/home.tsx": "export const Home = () => 'hi';",
      });
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      const out = await callTool(toolByName(tools, "readFile"), {
        path: "src/app/home.tsx",
      });
      expect(out).toContain("File: src/app/home.tsx");
      expect(out).toContain("export const Home");
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("returns a clear error when the path is unknown", async () => {
      const fetcher = stubFetcher({});
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      const out = await callTool(toolByName(tools, "readFile"), {
        path: "nonexistent.ts",
      });
      expect(out).toMatch(/not present in the repository/);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("validates that path is a string", async () => {
      const tools = createFileTools(baseContext, {
        fetchSingleFile: stubFetcher({}),
      });
      const out = await callTool(toolByName(tools, "readFile"), {});
      expect(out).toMatch(/required/);
    });

    it("caches repeated reads so a file is fetched at most once", async () => {
      const fetcher = stubFetcher({
        "src/app/home.tsx": "hello",
      });
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      const read = toolByName(tools, "readFile");
      await callTool(read, { path: "src/app/home.tsx" });
      await callTool(read, { path: "src/app/home.tsx" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("translates a rate-limit error into an actionable message", async () => {
      const fetcher = vi.fn().mockRejectedValue(new GitHubRateLimitError(42));
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      const out = await callTool(toolByName(tools, "readFile"), {
        path: "src/app/home.tsx",
      });
      expect(out).toMatch(/rate limit/i);
      expect(out).toMatch(/42/);
    });

    it("reports 404 responses as file-not-found", async () => {
      const fetcher = vi
        .fn()
        .mockRejectedValue(new GitHubApiError(404, "nope"));
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      const out = await callTool(toolByName(tools, "readFile"), {
        path: "src/app/home.tsx",
      });
      expect(out).toMatch(/not found/i);
    });

    it("truncates very large file contents and says so", async () => {
      const big = "x".repeat(70_000);
      const fetcher = stubFetcher({ "src/app/home.tsx": big });
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      const out = await callTool(toolByName(tools, "readFile"), {
        path: "src/app/home.tsx",
      });
      expect(out.length).toBeLessThan(big.length + 500);
      expect(out).toMatch(/truncated/);
    });
  });

  // -------------------------------------------------------------------------
  // searchFiles
  // -------------------------------------------------------------------------
  describe("searchFiles", () => {
    it("returns files matching a glob", async () => {
      const tools = createFileTools(baseContext, {
        fetchSingleFile: stubFetcher({}),
      });
      const out = await callTool(toolByName(tools, "searchFiles"), {
        pattern: "src/app/*.tsx",
      });
      expect(out).toContain("src/app/home.tsx");
      expect(out).toContain("src/app/login.tsx");
      expect(out).toContain("src/app/dashboard.tsx");
      expect(out).not.toContain("README.md");
    });

    it("reports when no files match", async () => {
      const tools = createFileTools(baseContext, {
        fetchSingleFile: stubFetcher({}),
      });
      const out = await callTool(toolByName(tools, "searchFiles"), {
        pattern: "nothing/*.rs",
      });
      expect(out).toMatch(/No files matched/);
    });

    it("requires a pattern argument", async () => {
      const tools = createFileTools(baseContext, {
        fetchSingleFile: stubFetcher({}),
      });
      const out = await callTool(toolByName(tools, "searchFiles"), {});
      expect(out).toMatch(/required/);
    });
  });

  // -------------------------------------------------------------------------
  // grepFiles
  // -------------------------------------------------------------------------
  describe("grepFiles", () => {
    it("finds lines matching a substring across files", async () => {
      const fetcher = stubFetcher({
        "src/app/home.tsx": "router.push('/dashboard');",
        "src/app/login.tsx":
          "function submit() {\n  router.push('/dashboard');\n}",
        "src/app/dashboard.tsx": "export const Dashboard = () => null;",
        "src/components/button.tsx": "export const Button = () => null;",
        "README.md": "# project",
      });
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      const out = await callTool(toolByName(tools, "grepFiles"), {
        query: "router.push",
        glob: "src/app/*.tsx",
      });
      expect(out).toContain("src/app/home.tsx");
      expect(out).toContain("src/app/login.tsx");
      expect(out).not.toContain("src/components/button.tsx");
    });

    it("respects the glob filter and avoids fetching unrelated files", async () => {
      const fetcher = stubFetcher({
        "src/app/home.tsx": "router.push('/x');",
        "src/app/login.tsx": "router.push('/y');",
        "src/app/dashboard.tsx": "router.push('/z');",
        "src/components/button.tsx": "router.push('/foo');",
      });
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      await callTool(toolByName(tools, "grepFiles"), {
        query: "router.push",
        glob: "src/app/*.tsx",
      });
      const requestedPaths = fetcher.mock.calls.map(
        (args) => (args[2] as TreeEntry).path,
      );
      expect(requestedPaths).not.toContain("src/components/button.tsx");
    });

    it("reports when nothing matches", async () => {
      const fetcher = stubFetcher({
        "src/app/home.tsx": "console.log('hi');",
      });
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      const out = await callTool(toolByName(tools, "grepFiles"), {
        query: "router.push",
        glob: "src/app/home.tsx",
      });
      expect(out).toMatch(/No matches/);
    });

    it("bails out with an actionable message on rate-limit", async () => {
      const fetcher = vi.fn().mockRejectedValue(new GitHubRateLimitError(10));
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      const out = await callTool(toolByName(tools, "grepFiles"), {
        query: "anything",
        glob: "src/**/*.tsx",
      });
      expect(out).toMatch(/rate limit/i);
    });

    it("silently skips files that 404 and continues scanning", async () => {
      const fetcher = vi
        .fn()
        .mockImplementation(async (_o, _r, entry: TreeEntry) => {
          if (entry.path === "src/app/login.tsx") {
            throw new GitHubApiError(404, "gone");
          }
          if (entry.path === "src/app/home.tsx") {
            return "router.push('/dashboard');";
          }
          return "nothing here";
        });
      const tools = createFileTools(baseContext, {
        fetchSingleFile: fetcher,
      });
      const out = await callTool(toolByName(tools, "grepFiles"), {
        query: "router.push",
        glob: "src/app/*.tsx",
      });
      expect(out).toContain("src/app/home.tsx");
      expect(out).not.toContain("src/app/login.tsx");
    });

    it("caps broad scans so grepFiles does not fetch the entire repository", async () => {
      const manyFiles = Array.from({ length: 205 }, (_, i) =>
        makeEntry(`src/generated/file-${i}.tsx`),
      );
      const fetcher = vi.fn().mockResolvedValue("no match here");
      const tools = createFileTools(
        {
          ...baseContext,
          files: manyFiles,
        },
        {
          fetchSingleFile: fetcher,
        },
      );
      const out = await callTool(toolByName(tools, "grepFiles"), {
        query: "router.push",
      });
      expect(fetcher).toHaveBeenCalledTimes(200);
      expect(out).toMatch(/Stopped after 200 file\(s\)/);
      expect(out).toMatch(/scanned 200 of 205 file\(s\)/);
    });

    it("requires a query argument", async () => {
      const tools = createFileTools(baseContext, {
        fetchSingleFile: stubFetcher({}),
      });
      const out = await callTool(toolByName(tools, "grepFiles"), {
        glob: "src/**/*.tsx",
      });
      expect(out).toMatch(/required/);
    });
  });
});
