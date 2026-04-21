/**
 * Copilot Custom Tools for On-Demand File Fetching
 *
 * Instead of embedding every file's content into the prompt (which quickly
 * blows past the per-request token limit on large repositories), the pipeline
 * exposes three tools that let Copilot fetch files selectively through the
 * GitHub REST API:
 *
 *   - readFile(path)                -> contents of a single file
 *   - searchFiles(pattern)          -> file paths matching a glob
 *   - grepFiles(query, glob?)       -> code search hits (GitHub Search API)
 *
 * All tools are bound to a repository context ({owner, repo, ref, token} +
 * a pre-fetched file tree) so the LLM only has to supply a path / pattern.
 *
 * Reference: issue #90 (方針B — Copilot のツール機能でファイル探索を委譲)
 */

import { minimatch } from "minimatch";
import type { Tool } from "@github/copilot-sdk";
import {
  fetchSingleFileContent,
  githubFetch,
  GitHubApiError,
  GitHubRateLimitError,
  type TreeEntry,
} from "./github-file-fetcher.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Repository context shared by all tools. */
export interface RepoContext {
  owner: string;
  repo: string;
  /** Branch or commit SHA used for raw file reads. */
  ref: string;
  /** GitHub OAuth token with repo read scope. */
  token: string;
  /** Full file tree — drives `searchFiles` and resolves paths for `readFile`. */
  files: TreeEntry[];
}

// ---------------------------------------------------------------------------
// Limits — protect the LLM (and the cache) from enormous tool outputs
// ---------------------------------------------------------------------------

/** Max characters returned by a single readFile call. */
const MAX_READ_FILE_CHARS = 60_000;

/** Max paths returned by searchFiles. */
const MAX_SEARCH_FILES_RESULTS = 200;

/** Max hits returned by grepFiles. */
const MAX_GREP_RESULTS = 30;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} characters]`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function formatGitHubError(err: unknown): string {
  if (err instanceof GitHubRateLimitError) {
    return `Error: GitHub API rate limit exceeded. Retry in ${err.retryAfterSeconds}s.`;
  }
  if (err instanceof GitHubApiError) {
    if (err.status === 404) return "Error: File not found.";
    if (err.status === 403) return "Error: Access denied by GitHub (403).";
    return `Error: GitHub API error (${err.status}).`;
  }
  if (err instanceof Error) return `Error: ${err.message}`;
  return "Error: Unknown failure while calling GitHub.";
}

// ---------------------------------------------------------------------------
// Tool: readFile
// ---------------------------------------------------------------------------

/**
 * Arguments for readFile — Copilot SDK passes raw JSON so we narrow at runtime.
 */
function parseReadFileArgs(
  args: unknown,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof args !== "object" || args === null) {
    return { ok: false, error: "Error: arguments must be an object." };
  }
  const record = args as Record<string, unknown>;
  if (!isNonEmptyString(record.path)) {
    return {
      ok: false,
      error: "Error: `path` is required and must be a string.",
    };
  }
  return { ok: true, path: record.path };
}

export function createReadFileTool(ctx: RepoContext): Tool<unknown> {
  const entriesByPath = new Map(ctx.files.map((f) => [f.path, f]));

  return {
    name: "readFile",
    description:
      "Read the UTF-8 contents of a single file from the repository. Supply the exact path as it appears in the repository (for example `src/app/page.tsx`). Large files are truncated. Returns the file contents, or an error string beginning with 'Error:' if the file cannot be read.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the file to read, relative to the repo root.",
        },
      },
      required: ["path"],
    },
    skipPermission: true,
    handler: async (args: unknown) => {
      const parsed = parseReadFileArgs(args);
      if (!parsed.ok) return parsed.error;

      const entry = entriesByPath.get(parsed.path);
      if (!entry) {
        return `Error: File not found in repository tree: ${parsed.path}`;
      }

      try {
        const content = await fetchSingleFileContent(
          ctx.owner,
          ctx.repo,
          entry,
          ctx.token,
          ctx.ref,
        );
        return truncate(content, MAX_READ_FILE_CHARS);
      } catch (err) {
        return formatGitHubError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: searchFiles
// ---------------------------------------------------------------------------

function parseSearchFilesArgs(
  args: unknown,
): { ok: true; pattern: string } | { ok: false; error: string } {
  if (typeof args !== "object" || args === null) {
    return { ok: false, error: "Error: arguments must be an object." };
  }
  const record = args as Record<string, unknown>;
  if (!isNonEmptyString(record.pattern)) {
    return {
      ok: false,
      error: "Error: `pattern` is required and must be a non-empty string.",
    };
  }
  return { ok: true, pattern: record.pattern };
}

export function createSearchFilesTool(ctx: RepoContext): Tool<unknown> {
  return {
    name: "searchFiles",
    description:
      "List repository file paths matching a glob pattern (e.g. `src/**/*.tsx`, `app/**/page.ts?(x)`). Returns one path per line, capped at 200 results. Use this to discover files before calling readFile.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "A glob pattern (minimatch syntax). Examples: `src/**/*.ts`, `**/routes.*`.",
        },
      },
      required: ["pattern"],
    },
    skipPermission: true,
    handler: (args: unknown) => {
      const parsed = parseSearchFilesArgs(args);
      if (!parsed.ok) return parsed.error;

      const matches = ctx.files.filter((f) =>
        minimatch(f.path, parsed.pattern),
      );
      if (matches.length === 0) {
        return `No files match pattern: ${parsed.pattern}`;
      }

      const truncated = matches.slice(0, MAX_SEARCH_FILES_RESULTS);
      const header =
        matches.length > MAX_SEARCH_FILES_RESULTS
          ? `Showing first ${MAX_SEARCH_FILES_RESULTS} of ${matches.length} matches.\n`
          : "";
      return header + truncated.map((f) => f.path).join("\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: grepFiles
// ---------------------------------------------------------------------------

function parseGrepFilesArgs(
  args: unknown,
): { ok: true; query: string; glob?: string } | { ok: false; error: string } {
  if (typeof args !== "object" || args === null) {
    return { ok: false, error: "Error: arguments must be an object." };
  }
  const record = args as Record<string, unknown>;
  if (!isNonEmptyString(record.query)) {
    return {
      ok: false,
      error: "Error: `query` is required and must be a non-empty string.",
    };
  }
  const globValue = record.glob;
  if (globValue !== undefined && !isNonEmptyString(globValue)) {
    return {
      ok: false,
      error: "Error: `glob` must be a non-empty string if provided.",
    };
  }
  return { ok: true, query: record.query, glob: globValue };
}

/** Shape of a hit in GitHub's code search response. */
interface CodeSearchItem {
  path: string;
  repository?: { full_name?: string };
}
interface CodeSearchResponse {
  total_count: number;
  incomplete_results?: boolean;
  items: CodeSearchItem[];
}

export function createGrepFilesTool(ctx: RepoContext): Tool<unknown> {
  return {
    name: "grepFiles",
    description:
      "Search repository source for a text/code query using GitHub's code search API. Returns matching file paths (one per line). Optionally pass a `glob` to pre-filter results client-side. Use this when you know a keyword (e.g. `useNavigate`, `router.push`) but not which files contain it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Query passed to GitHub code search, scoped to this repo. Keep it short; do not include `repo:` qualifiers.",
        },
        glob: {
          type: "string",
          description: "Optional glob used to post-filter the results.",
        },
      },
      required: ["query"],
    },
    skipPermission: true,
    handler: async (args: unknown) => {
      const parsed = parseGrepFilesArgs(args);
      if (!parsed.ok) return parsed.error;

      const repoQualifier = `repo:${ctx.owner}/${ctx.repo}`;
      const q = `${parsed.query} ${repoQualifier}`;
      const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=${MAX_GREP_RESULTS}`;

      let response: CodeSearchResponse;
      try {
        response = await githubFetch<CodeSearchResponse>(url, ctx.token);
      } catch (err) {
        return formatGitHubError(err);
      }

      let hits = response.items.map((item) => item.path);
      if (parsed.glob) {
        const pattern = parsed.glob;
        hits = hits.filter((path) => minimatch(path, pattern));
      }
      if (hits.length === 0) {
        return `No matches found for query: ${parsed.query}`;
      }

      const header =
        response.total_count > hits.length
          ? `Showing ${hits.length} of ${response.total_count} total hits (API-capped at ${MAX_GREP_RESULTS}).\n`
          : "";
      return header + hits.join("\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build the three custom tools the analysis pipeline exposes to Copilot.
 * All three are bound to the same repository context.
 */
export function createAnalysisTools(ctx: RepoContext): Tool<unknown>[] {
  return [
    createReadFileTool(ctx),
    createSearchFilesTool(ctx),
    createGrepFilesTool(ctx),
  ];
}
