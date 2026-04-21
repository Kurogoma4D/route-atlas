/**
 * Copilot SDK Custom Tools — GitHub file exploration.
 *
 * These tools let the LLM explore a repository on-demand instead of receiving
 * every file's contents pre-embedded in the prompt. By deferring file reads to
 * the model, we keep prompt tokens low and avoid the 64k-token API error on
 * large repositories.
 *
 * Three tools are exposed:
 *   - readFile(path)      — fetch a single file's contents via the GitHub Contents API
 *   - searchFiles(pattern)— filter the pre-fetched file tree with a glob pattern
 *   - grepFiles(query, glob?) — search code contents via the GitHub Search API
 *
 * All tools handle rate-limit and not-found errors cleanly, returning a
 * structured `ToolResultObject` the model can interpret rather than throwing
 * (which would abort the session).
 *
 * Reference: SPEC.md §5.4 — file exploration is now agent-driven.
 */

import { minimatch } from "minimatch";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import {
  decodeBase64Content,
  fetchViaBlobApi,
  githubFetch,
  GitHubApiError,
  GitHubRateLimitError,
  type ContentsResponse,
  type TreeEntry,
} from "./github-file-fetcher.js";

/**
 * Number of retries to pass to githubFetch for custom-tool calls. Zero means
 * we fail fast — the LLM can decide whether to retry by invoking the tool
 * again (it sees the rate-limit error in the structured failure result).
 */
const CUSTOM_TOOL_RETRIES = 0;

// ---------------------------------------------------------------------------
// Repository context
// ---------------------------------------------------------------------------

/**
 * Everything the custom tools need to talk to GitHub on the user's behalf.
 *
 * `fileTree` is the pre-fetched list of blob entries for the repo — the same
 * list we already resolve once when an analysis job starts. Supplying it here
 * lets `searchFiles` answer glob queries locally (zero API cost) and lets
 * `readFile` look up a blob SHA for large files without an extra round-trip.
 */
export interface RepositoryContext {
  /** Repository owner (e.g. "Kurogoma4D"). */
  owner: string;
  /** Repository name (e.g. "route-atlas"). */
  repo: string;
  /** Ref — a branch name, tag, or commit SHA. Used when reading files. */
  ref: string;
  /** OAuth access token with `repo` scope. */
  token: string;
  /** All blob entries discovered by `fetchFileTree`. */
  fileTree: TreeEntry[];
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

/** Build a success result the LLM can consume. */
function success(text: string): ToolResultObject {
  return { resultType: "success", textResultForLlm: text };
}

/** Build a failure result with a short, model-friendly message. */
function failure(message: string): ToolResultObject {
  return {
    resultType: "failure",
    textResultForLlm: message,
    error: message,
  };
}

/**
 * Convert any thrown error from a GitHub call into a ToolResultObject so the
 * LLM sees a structured response rather than the session crashing.
 */
function mapErrorToResult(
  err: unknown,
  contextLabel: string,
): ToolResultObject {
  if (err instanceof GitHubRateLimitError) {
    return failure(
      `GitHub API rate limit exceeded while ${contextLabel}. Retry after ${err.retryAfterSeconds} seconds.`,
    );
  }
  if (err instanceof GitHubApiError) {
    if (err.status === 404) {
      return failure(`${contextLabel}: file or resource not found (HTTP 404).`);
    }
    if (err.status === 403) {
      return failure(
        `${contextLabel}: access forbidden (HTTP 403). The resource may be private or rate-limited.`,
      );
    }
    return failure(`${contextLabel}: GitHub API error (HTTP ${err.status}).`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return failure(`${contextLabel}: ${message}`);
}

// ---------------------------------------------------------------------------
// Argument parsers (tools receive unknown from the SDK)
// ---------------------------------------------------------------------------

function getStringArg(args: unknown, key: string): string | null {
  if (typeof args !== "object" || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getOptionalStringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

/** Hard cap on file content returned to the LLM — prevents a single huge file from blowing past token limits. */
export const READ_FILE_MAX_CHARS = 60_000;

const GITHUB_API_BASE_FOR_READ = "https://api.github.com";

async function fetchFileViaContentsApi(
  context: RepositoryContext,
  repoRelativePath: string,
): Promise<string> {
  const encodedPath = repoRelativePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const url = `${GITHUB_API_BASE_FOR_READ}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(context.ref)}`;
  const data = await githubFetch<ContentsResponse>(
    url,
    context.token,
    CUSTOM_TOOL_RETRIES,
  );
  return decodeBase64Content(data.content);
}

/** Internal implementation — exported for unit tests. */
export async function readFileImpl(
  context: RepositoryContext,
  path: string,
): Promise<ToolResultObject> {
  if (!path || typeof path !== "string") {
    return failure(
      "readFile: 'path' argument is required and must be a non-empty string.",
    );
  }

  // Look up blob in the pre-fetched tree first. If the file is above the 1MB
  // Contents API limit, we go straight to the Blob API via its SHA — this also
  // avoids a redundant 403-then-fallback round-trip.
  const normalized = path.replace(/^\.\//, "");
  const entry = context.fileTree.find((e) => e.path === normalized);

  let content: string;
  try {
    const isLargeFile =
      entry && entry.size !== undefined && entry.size > 1_000_000;
    if (isLargeFile && entry) {
      content = await fetchViaBlobApi(
        context.owner,
        context.repo,
        entry.sha,
        context.token,
      );
    } else {
      try {
        content = await fetchFileViaContentsApi(context, normalized);
      } catch (err) {
        // If the Contents API rejects the file as too large, fall back to the
        // Blob API — but only when we have the SHA from the tree.
        if (err instanceof GitHubApiError && err.status === 403 && entry) {
          content = await fetchViaBlobApi(
            context.owner,
            context.repo,
            entry.sha,
            context.token,
          );
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    return mapErrorToResult(err, `reading file '${path}'`);
  }

  if (content.length > READ_FILE_MAX_CHARS) {
    const truncated = content.slice(0, READ_FILE_MAX_CHARS);
    return success(
      `File: ${path}\n(content truncated to ${READ_FILE_MAX_CHARS} characters of ${content.length})\n\n${truncated}`,
    );
  }

  return success(`File: ${path}\n\n${content}`);
}

// ---------------------------------------------------------------------------
// searchFiles
// ---------------------------------------------------------------------------

/** Upper bound on number of paths returned so the LLM doesn't drown in matches. */
export const SEARCH_FILES_MAX_RESULTS = 200;

/** Internal implementation — exported for unit tests. */
export function searchFilesImpl(
  context: RepositoryContext,
  pattern: string,
): ToolResultObject {
  if (!pattern || typeof pattern !== "string") {
    return failure(
      "searchFiles: 'pattern' argument is required and must be a non-empty string.",
    );
  }

  let matches: string[];
  try {
    matches = context.fileTree
      .filter((entry) => minimatch(entry.path, pattern, { dot: true }))
      .map((entry) => entry.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(
      `searchFiles: invalid glob pattern '${pattern}': ${message}`,
    );
  }

  if (matches.length === 0) {
    return success(`No files matched pattern '${pattern}'.`);
  }

  const truncated = matches.length > SEARCH_FILES_MAX_RESULTS;
  const shown = truncated
    ? matches.slice(0, SEARCH_FILES_MAX_RESULTS)
    : matches;

  const header = truncated
    ? `Found ${matches.length} files matching '${pattern}' (showing first ${SEARCH_FILES_MAX_RESULTS}):`
    : `Found ${matches.length} file(s) matching '${pattern}':`;

  return success(`${header}\n${shown.join("\n")}`);
}

// ---------------------------------------------------------------------------
// grepFiles
// ---------------------------------------------------------------------------

/** GitHub code-search result shape (subset we use). */
interface CodeSearchItem {
  name: string;
  path: string;
  repository: { full_name: string };
}

interface CodeSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: CodeSearchItem[];
}

/** Upper bound on grep matches to show the LLM. */
export const GREP_FILES_MAX_RESULTS = 30;

const GITHUB_API_BASE = "https://api.github.com";

/** Internal implementation — exported for unit tests. */
export async function grepFilesImpl(
  context: RepositoryContext,
  query: string,
  glob?: string,
): Promise<ToolResultObject> {
  if (!query || typeof query !== "string") {
    return failure(
      "grepFiles: 'query' argument is required and must be a non-empty string.",
    );
  }

  // Build a repo-qualified search. GitHub's code-search DSL supports
  // `repo:owner/name` and `path:` for glob-style filtering.
  const parts = [query, `repo:${context.owner}/${context.repo}`];
  if (glob) {
    parts.push(`path:${glob}`);
  }
  const q = parts.join(" ");
  const url = `${GITHUB_API_BASE}/search/code?q=${encodeURIComponent(q)}&per_page=${GREP_FILES_MAX_RESULTS}`;

  let response: CodeSearchResponse;
  try {
    response = await githubFetch<CodeSearchResponse>(
      url,
      context.token,
      CUSTOM_TOOL_RETRIES,
    );
  } catch (err) {
    return mapErrorToResult(err, `searching code for '${query}'`);
  }

  if (response.items.length === 0) {
    const globSuffix = glob ? ` (glob: ${glob})` : "";
    return success(`No code matches found for '${query}'${globSuffix}.`);
  }

  const lines = response.items.map((item) => `- ${item.path}`);
  const header = `Code search for '${query}' found ${response.total_count} match(es); showing file paths for up to ${GREP_FILES_MAX_RESULTS}:`;
  const footer = response.incomplete_results
    ? "\n(GitHub reported partial results; narrow the query for completeness.)"
    : "";

  return success(`${header}\n${lines.join("\n")}${footer}`);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Produce the three custom tools bound to the given repository context.
 *
 * The handlers close over `context`, so each session gets a fresh set of tools
 * tailored to the repo/ref/token being analysed. `skipPermission: true` ensures
 * the SDK does not prompt for per-call approval (we already authorize at the
 * session level via `approveAll`).
 */
export function createCustomTools(context: RepositoryContext): Tool[] {
  return [
    {
      name: "readFile",
      description:
        "Read the full contents of a single file from the repository being analysed. Use this when you need to inspect a specific file's source code. Accepts the repo-relative path (e.g. 'src/app/routes.ts').",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Repo-relative path to the file (e.g. 'src/app/page.tsx').",
          },
        },
        required: ["path"],
      },
      skipPermission: true,
      handler: async (args) => {
        const path = getStringArg(args, "path");
        if (!path) {
          return failure(
            "readFile: 'path' argument is required and must be a non-empty string.",
          );
        }
        return readFileImpl(context, path);
      },
    },
    {
      name: "searchFiles",
      description:
        "List files in the repository whose paths match a glob pattern (e.g. '**/*.tsx', 'src/app/**/page.*'). Matches are resolved locally against the pre-fetched file tree, so this is free and fast. Use it to discover candidate files to read.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "A glob pattern matched against repo-relative paths (minimatch syntax).",
          },
        },
        required: ["pattern"],
      },
      skipPermission: true,
      handler: (args) => {
        const pattern = getStringArg(args, "pattern");
        if (!pattern) {
          return failure(
            "searchFiles: 'pattern' argument is required and must be a non-empty string.",
          );
        }
        return searchFilesImpl(context, pattern);
      },
    },
    {
      name: "grepFiles",
      description:
        "Search the repository's source code for a literal string or identifier via the GitHub code-search API. Optionally restrict matches with a path glob. Returns a list of file paths containing the query. Use this to find usages (e.g. 'router.push') when you do not know which file contains them.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Code-search query — typically an identifier or literal string.",
          },
          glob: {
            type: "string",
            description: "Optional path filter (e.g. 'src/**/*.tsx').",
          },
        },
        required: ["query"],
      },
      skipPermission: true,
      handler: async (args) => {
        const query = getStringArg(args, "query");
        if (!query) {
          return failure(
            "grepFiles: 'query' argument is required and must be a non-empty string.",
          );
        }
        const glob = getOptionalStringArg(args, "glob");
        return grepFilesImpl(context, query, glob);
      },
    },
  ];
}
