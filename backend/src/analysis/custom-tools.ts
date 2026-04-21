/**
 * Custom Copilot SDK Tools for On-Demand File Exploration
 *
 * Instead of embedding full file contents into the Turn 2 / Turn 3 prompts,
 * the LLM is given a set of custom tools so it can fetch only the files it
 * actually needs. This sidesteps the 64k-token prompt limit for large repos.
 *
 * Three tools are exposed to the model:
 *
 *   - readFile(path)               — fetch a file's contents from the repo.
 *   - searchFiles(pattern)         — glob-match the cached file tree.
 *   - grepFiles(query, glob?)      — search code via GitHub Search API.
 *
 * Each tool returns a plain string result (success text or a short error
 * message). Failures — rate-limit, file-not-found, unknown API errors — are
 * surfaced as text so the model can adapt rather than the whole turn aborting.
 *
 * Reference: issue #90
 */
import type { Tool } from "@github/copilot-sdk";
import { minimatch } from "minimatch";
import {
  GitHubApiError,
  GitHubRateLimitError,
  fetchSingleFileContent,
  githubFetch,
  type TreeEntry,
} from "./github-file-fetcher.js";

// ---------------------------------------------------------------------------
// Types & options
// ---------------------------------------------------------------------------

/** Repository coordinates needed by every custom tool. */
export interface RepoContext {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

/**
 * Options for building the custom-tool set.
 *
 * `allFiles` is the pre-fetched repository tree (blobs only). It is used by
 * `searchFiles` for glob matching and by `readFile` to resolve a path to a
 * tree entry (for the blob SHA and size).
 */
export interface CustomToolsOptions extends RepoContext {
  allFiles: TreeEntry[];
  /**
   * Maximum bytes of file content returned by a single `readFile` call.
   * Content longer than this is truncated with a trailing "[truncated]" marker.
   * Defaults to 80_000 characters (~20k tokens).
   */
  maxFileBytes?: number;
  /**
   * Maximum number of search results returned by `searchFiles` / `grepFiles`.
   * Defaults to 50.
   */
  maxSearchResults?: number;
}

const DEFAULT_MAX_FILE_BYTES = 80_000;
const DEFAULT_MAX_SEARCH_RESULTS = 50;

// ---------------------------------------------------------------------------
// JSON-Schema parameter definitions
//
// The SDK accepts plain JSON Schema objects for tool parameters; we do not
// pull in zod just for this.
// ---------------------------------------------------------------------------

const READ_FILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Repository-relative path to the file (e.g. 'src/app/home.tsx').",
    },
  },
  required: ["path"],
  additionalProperties: false,
};

const SEARCH_FILES_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        "Glob pattern matched against file paths (e.g. 'src/**/*.tsx').",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
};

const GREP_FILES_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Substring or GitHub code-search query to search for.",
    },
    glob: {
      type: "string",
      description:
        "Optional glob pattern to restrict matched files (e.g. '**/*.tsx').",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Argument narrowing helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Convert an arbitrary error thrown by the underlying GitHub helpers into a
 * stable, LLM-friendly string. Rate-limit errors embed the retry window so
 * the model can decide whether to try a cheaper alternative tool.
 */
export function formatToolError(err: unknown): string {
  if (err instanceof GitHubRateLimitError) {
    return `Error: GitHub API rate limit exceeded. Retry after ${err.retryAfterSeconds} seconds. Consider using a different tool or skipping this file.`;
  }
  if (err instanceof GitHubApiError) {
    if (err.status === 404) {
      return "Error: File not found in the repository.";
    }
    return `Error: GitHub API returned ${err.status}.`;
  }
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return "Error: Unknown failure while calling GitHub API.";
}

function truncate(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n[truncated: ${content.length - max} bytes omitted]`;
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

/**
 * Response shape of `GET /search/code?q=...`.
 * Only the fields we actually consume are declared.
 */
interface SearchCodeResponse {
  total_count: number;
  incomplete_results: boolean;
  items: { path: string }[];
}

// ---------------------------------------------------------------------------
// Sensitive-path filtering
// ---------------------------------------------------------------------------

/**
 * Patterns that identify files that must never be handed to the LLM, even if
 * they happen to be committed to the repository tree. Matches are checked
 * against both the full path and the basename.
 */
const SENSITIVE_PATH_RE: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /credential/i,
  /secret/i,
  /private[_-]?key/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
];

function isSensitivePath(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;
  return SENSITIVE_PATH_RE.some(
    (re) => re.test(basename) || re.test(filePath),
  );
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Build the three custom tools for a single analysis run.
 *
 * The returned array can be passed straight to
 * `SessionConfig.tools` — or, equivalently, to our `LLMAdapter.chatCompletion`
 * `tools` option.
 */
export function createCustomTools(
  options: CustomToolsOptions,
): Tool<unknown>[] {
  const {
    owner,
    repo,
    branch,
    token,
    allFiles,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxSearchResults = DEFAULT_MAX_SEARCH_RESULTS,
  } = options;

  // Index the tree by path for O(1) lookups inside readFile.
  // Sensitive files (credentials, keys, .env, …) are excluded so the LLM
  // cannot read them even if they are committed to the repository.
  const byPath = new Map<string, TreeEntry>();
  for (const f of allFiles) {
    if (!isSensitivePath(f.path)) byPath.set(f.path, f);
  }

  // Cache promises so concurrent LLM sessions don't fetch the same file twice.
  const readCache = new Map<string, Promise<string>>();
  // Cache for grepFiles results (keyed on sanitizedQuery + "\0" + glob).
  const grepCache = new Map<string, Promise<string>>();
  // Cache for searchFiles results (keyed on the glob pattern).
  const searchCache = new Map<string, string>();

  const readFileTool: Tool<unknown> = {
    name: "readFile",
    description:
      "Fetch the contents of a single file from the repository. Accepts a repository-relative path. Returns the file contents as a string, or an error message if the file does not exist or cannot be fetched.",
    parameters: READ_FILE_SCHEMA,
    skipPermission: true,
    handler: async (args: unknown): Promise<string> => {
      if (!isRecord(args)) return "Error: invalid arguments.";
      const path = asString(args.path);
      if (!path) {
        return "Error: 'path' argument is required and must be a string.";
      }

      const entry = byPath.get(path);
      if (!entry) {
        return "Error: File not found.";
      }

      const cached = readCache.get(path);
      if (cached) return cached;

      const result = fetchSingleFileContent(owner, repo, entry, token, branch)
        .then((content) => truncate(content, maxFileBytes))
        .catch((err: unknown) => {
          // Do not cache errors so transient failures can be retried.
          readCache.delete(path);
          return formatToolError(err);
        });
      readCache.set(path, result);
      return result;
    },
  };

  const searchFilesTool: Tool<unknown> = {
    name: "searchFiles",
    description:
      "Find files in the repository whose path matches a glob pattern. Useful when you need to discover which files exist without reading them. Returns a newline-separated list of file paths (may be empty).",
    parameters: SEARCH_FILES_SCHEMA,
    skipPermission: true,
    handler: (args: unknown): string => {
      if (!isRecord(args)) return "Error: invalid arguments.";
      const pattern = asString(args.pattern);
      if (!pattern) {
        return "Error: 'pattern' argument is required and must be a string.";
      }

      const matched: string[] = [];

      const cachedSearch = searchCache.get(pattern);
      if (cachedSearch !== undefined) return cachedSearch;

      for (const filePath of byPath.keys()) {
        if (minimatch(filePath, pattern)) {
          matched.push(filePath);
          if (matched.length >= maxSearchResults) break;
        }
      }

      if (matched.length === 0) {
        searchCache.set(pattern, "(no files matched)");
        return "(no files matched)";
      }
      const searchResult = matched.join("\n");
      searchCache.set(pattern, searchResult);
      return searchResult;
    },
  };

  const grepFilesTool: Tool<unknown> = {
    name: "grepFiles",
    description:
      "Search the repository code for a substring or GitHub code-search query. Optionally restrict to files matching a glob. Returns a newline-separated list of file paths that contain a match.",
    parameters: GREP_FILES_SCHEMA,
    skipPermission: true,
    handler: async (args: unknown): Promise<string> => {
      if (!isRecord(args)) return "Error: invalid arguments.";
      const query = asString(args.query);
      if (!query) {
        return "Error: 'query' argument is required and must be a string.";
      }
      const glob = asString(args.glob);

      try {
        // Strip any GitHub search qualifiers the LLM may have injected
        // (e.g. `repo:attacker/private` would escape the intended scope).
        const sanitizedQuery = query
          .replace(
            /\b(repo|org|user|language|path|extension|filename|in|type|fork|size|stars|forks):[^\s]*/gi,
            "",
          )
          .trim();
        if (!sanitizedQuery) {
          return "Error: 'query' must contain at least one search term.";
        }

        const cacheKey = `${sanitizedQuery}\0${glob ?? ""}`;
        const cachedGrep = grepCache.get(cacheKey);
        if (cachedGrep) return cachedGrep;

        const grepResult: Promise<string> = (async () => {
          const q = `${sanitizedQuery} repo:${owner}/${repo}`;
          const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=${maxSearchResults}`;
          const data = await githubFetch<SearchCodeResponse>(url, token);

          let paths = data.items
            .map((item) => item.path)
            .filter((p) => byPath.has(p));
          if (glob) {
            paths = paths.filter((p) => minimatch(p, glob));
          }
          if (paths.length === 0) return "(no matches)";
          return paths.join("\n");
        })().catch((err: unknown) => {
          // Do not cache errors so transient failures can be retried.
          grepCache.delete(cacheKey);
          return formatToolError(err);
        });
        grepCache.set(cacheKey, grepResult);
        return grepResult;
      } catch (err) {
        return formatToolError(err);
      }
    },
  };

  return [readFileTool, searchFilesTool, grepFilesTool];
}
