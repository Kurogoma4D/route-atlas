/**
 * Copilot Custom Tools
 *
 * Defines custom tools that the Copilot SDK can invoke during a session so
 * the LLM can fetch repository files on demand rather than receiving every
 * file embedded in the prompt. This is the core of the "delegate file lookup
 * to Copilot" approach (see Issue #90).
 *
 * Three tools are exposed:
 *  - `readFile(path)`      — fetch the textual content of a single file
 *  - `searchFiles(pattern)` — list files whose paths match a glob pattern
 *  - `grepFiles(query, glob?)` — search inside files for a substring
 *
 * Tool handlers are adapters over the existing github-file-fetcher module.
 * They return structured failure results where appropriate, but some
 * operations are best-effort: e.g. search may return partial results with
 * notes on truncation and may skip missing or unreadable files.
 */

import { minimatch } from "minimatch";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import {
  fetchSingleFileContent,
  GitHubApiError,
  GitHubRateLimitError,
  type TreeEntry,
} from "./github-file-fetcher.js";

// ---------------------------------------------------------------------------
// Repo context — everything the tools need to serve a request
// ---------------------------------------------------------------------------

/**
 * Context describing the repository a Copilot session is analysing.
 *
 * `treeFiles` is the pre-fetched list of blob entries in the repository; the
 * tools operate against this list (so `searchFiles` never calls the GitHub
 * API, only `readFile` and `grepFiles` do).
 */
export interface RepoContext {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  treeFiles: TreeEntry[];
}

// ---------------------------------------------------------------------------
// Tool argument & result shapes
// ---------------------------------------------------------------------------

export interface ReadFileArgs {
  path: string;
}

export interface SearchFilesArgs {
  pattern: string;
}

export interface GrepFilesArgs {
  query: string;
  glob?: string;
}

/** Shared limits — tuned to keep tool responses well under the model context. */
const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_GREP_MATCHES = 50;
const DEFAULT_MAX_FILE_BYTES = 200_000;
const DEFAULT_GREP_CONTEXT_LINES = 2;
/**
 * Skip individual files larger than this when grepping, to avoid pulling
 * multi-MB blobs (bundles, lockfiles, minified vendors) over the network
 * just to scan a handful of lines.
 */
const GREP_MAX_FILE_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function success(textResultForLlm: string): ToolResultObject {
  return {
    textResultForLlm,
    resultType: "success",
  };
}

function failure(message: string, error?: string): ToolResultObject {
  return {
    textResultForLlm: message,
    resultType: "failure",
    error: error ?? message,
  };
}

/** Match a path against a glob pattern, accepting both `src/**` and `**\/foo.ts` forms. */
function matchGlob(path: string, pattern: string): boolean {
  return minimatch(path, pattern, { nocase: false, dot: true });
}

/**
 * Truncate `content` so its UTF-8 byte-size fits within `maxBytes`.
 *
 * Iterates the string by Unicode characters (so we never split a multi-byte
 * codepoint mid-byte) and measures each character's UTF-8 width via
 * `Buffer.byteLength(char, "utf8")`. Appends a language-neutral banner
 * reporting the number of bytes dropped so the model sees an accurate
 * truncation notice without injecting syntax that looks like a comment in
 * any particular language (files may be YAML, Swift, XML, etc.).
 */
function truncateLines(content: string, maxBytes: number): string {
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (totalBytes <= maxBytes) return content;

  let headBytes = 0;
  let head = "";
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (headBytes + charBytes > maxBytes) break;
    head += char;
    headBytes += charBytes;
  }
  const bytesOmitted = totalBytes - headBytes;
  return `${head}\n--- [truncated: ${bytesOmitted} bytes omitted, file exceeded ${maxBytes} bytes] ---\n`;
}

/**
 * Map a thrown error to a structured tool failure result so the LLM can
 * decide how to proceed (e.g. try a different file, stop searching).
 */
function errorToResult(err: unknown, context: string): ToolResultObject {
  if (err instanceof GitHubRateLimitError) {
    return failure(
      `GitHub API rate limit exceeded while ${context}. Retry after ${err.retryAfterSeconds}s.`,
      err.message,
    );
  }
  if (err instanceof GitHubApiError) {
    if (err.status === 404) {
      return failure(`File not found while ${context}.`, err.message);
    }
    // `err.message` already carries the `GitHub API error (<status>): ...`
    // prefix (see GitHubApiError in github-file-fetcher.ts), so we just
    // frame it with the current operation context to avoid duplication.
    return failure(`Error while ${context}: ${err.message}`, err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return failure(`Unexpected error while ${context}: ${msg}`, msg);
}

// ---------------------------------------------------------------------------
// Tool handlers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Fetch a file's text content by path. */
export async function handleReadFile(
  ctx: RepoContext,
  args: ReadFileArgs,
  options?: { maxBytes?: number },
): Promise<ToolResultObject> {
  const { path } = args;
  if (typeof path !== "string" || path.length === 0) {
    return failure("`path` must be a non-empty string.");
  }

  const entry = ctx.treeFiles.find((f) => f.path === path);
  if (!entry) {
    return failure(
      `File "${path}" was not found in the repository tree. Use searchFiles to discover valid paths.`,
    );
  }

  try {
    const content = await fetchSingleFileContent(
      ctx.owner,
      ctx.repo,
      entry,
      ctx.token,
      ctx.branch,
    );
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
    return success(truncateLines(content, maxBytes));
  } catch (err) {
    return errorToResult(err, `reading "${path}"`);
  }
}

/** List all file paths in the tree matching the given glob. */
export function handleSearchFiles(
  ctx: RepoContext,
  args: SearchFilesArgs,
  options?: { maxResults?: number },
): ToolResultObject {
  const { pattern } = args;
  if (typeof pattern !== "string" || pattern.length === 0) {
    return failure("`pattern` must be a non-empty glob string.");
  }

  const limit = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const matches: string[] = [];
  for (const entry of ctx.treeFiles) {
    if (matchGlob(entry.path, pattern)) {
      matches.push(entry.path);
      if (matches.length >= limit) break;
    }
  }

  if (matches.length === 0) {
    return success(`No files matched pattern "${pattern}".`);
  }

  const header =
    matches.length >= limit
      ? `Matched files for "${pattern}" (truncated at ${limit}):\n`
      : `Matched files for "${pattern}":\n`;

  return success(`${header}${matches.join("\n")}`);
}

/**
 * Search for a literal substring inside files matching the optional glob.
 *
 * Pulls each candidate file via the Contents API and grep's locally. Returns
 * matching lines (with a small amount of context) up to `maxMatches` total.
 */
export async function handleGrepFiles(
  ctx: RepoContext,
  args: GrepFilesArgs,
  options?: {
    maxMatches?: number;
    maxFilesToScan?: number;
    contextLines?: number;
  },
): Promise<ToolResultObject> {
  const { query, glob } = args;
  if (typeof query !== "string" || query.length === 0) {
    return failure("`query` must be a non-empty string.");
  }

  const candidates = ctx.treeFiles.filter((entry) =>
    glob ? matchGlob(entry.path, glob) : true,
  );

  const maxMatches = options?.maxMatches ?? DEFAULT_MAX_GREP_MATCHES;
  const maxFilesToScan = options?.maxFilesToScan ?? 100;
  const contextLines = options?.contextLines ?? DEFAULT_GREP_CONTEXT_LINES;

  if (candidates.length === 0) {
    return success(
      glob
        ? `No files matched glob "${glob}" — nothing to grep.`
        : `Repository tree is empty — nothing to grep.`,
    );
  }

  const toScan = candidates.slice(0, maxFilesToScan);
  const hits: string[] = [];
  let totalMatches = 0;
  let scannedFiles = 0;
  let skippedLargeFiles = 0;

  for (const entry of toScan) {
    if (totalMatches >= maxMatches) break;
    // Per-file size guard: the tree API reports blob sizes, so we can skip
    // oversized files without spending a Contents API call on them.
    if (typeof entry.size === "number" && entry.size > GREP_MAX_FILE_BYTES) {
      skippedLargeFiles++;
      continue;
    }
    scannedFiles++;
    let content: string;
    try {
      content = await fetchSingleFileContent(
        ctx.owner,
        ctx.repo,
        entry,
        ctx.token,
        ctx.branch,
      );
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        // Stop the scan entirely on rate-limit — return what we have so far.
        hits.push(
          `// (rate-limit hit while scanning "${entry.path}" — results truncated)`,
        );
        break;
      }
      // Skip unreadable files (e.g. 404, binary) but keep going.
      continue;
    }

    const lines = content.split("\n");
    const fileHits: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(query)) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        const snippet = lines
          .slice(start, end + 1)
          .map((l, offset) => `${start + offset + 1}: ${l}`)
          .join("\n");
        fileHits.push(snippet);
        totalMatches++;
        if (totalMatches >= maxMatches) break;
      }
    }

    if (fileHits.length > 0) {
      hits.push(`### ${entry.path}\n${fileHits.join("\n---\n")}`);
    }
  }

  const skippedSuffix =
    skippedLargeFiles > 0
      ? `; ${skippedLargeFiles} large file${skippedLargeFiles === 1 ? "" : "s"} skipped (>${GREP_MAX_FILE_BYTES} bytes)`
      : "";

  if (hits.length === 0) {
    return success(
      `No matches for "${query}"${glob ? ` in "${glob}"` : ""} (scanned ${scannedFiles} files${skippedSuffix}).`,
    );
  }

  const truncatedNote =
    totalMatches >= maxMatches
      ? `\n\n(Results truncated at ${maxMatches} matches. Narrow your glob to search further.)`
      : "";

  return success(
    `Matches for "${query}"${glob ? ` in "${glob}"` : ""} (${totalMatches} hit${totalMatches === 1 ? "" : "s"} in ${hits.length} file${hits.length === 1 ? "" : "s"}${skippedSuffix}):\n\n${hits.join("\n\n")}${truncatedNote}`,
  );
}

// ---------------------------------------------------------------------------
// Tool factory — builds Copilot SDK Tool definitions bound to a RepoContext
// ---------------------------------------------------------------------------

/**
 * Build the three Copilot SDK `Tool` definitions bound to a repo context.
 *
 * Intended lifetime: one invocation covers a single analysis turn / session.
 * Callers may provide the same context for multiple turns of the same job.
 */
export function buildRepoTools(ctx: RepoContext): Tool[] {
  const readFileTool: Tool = {
    name: "readFile",
    description:
      "Read the textual content of a single file in the repository. Returns the full file contents (truncated if very large). Use this after using searchFiles / grepFiles to identify the file you need.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Repository-relative file path, e.g. 'src/app/routes.ts'. Must match an entry returned by searchFiles.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    skipPermission: true,
    handler: (args) => handleReadFile(ctx, coerceReadFileArgs(args)),
  };

  const searchFilesTool: Tool = {
    name: "searchFiles",
    description:
      "List repository file paths matching a glob pattern (e.g. 'src/**/*.tsx', '**/routes.ts'). Uses minimatch glob syntax. Does NOT return file contents — use readFile afterwards.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern to match file paths. Examples: 'src/pages/**/*.tsx', '**/*.astro', 'app/routes/**'.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    skipPermission: true,
    handler: (args) => handleSearchFiles(ctx, coerceSearchFilesArgs(args)),
  };

  const grepFilesTool: Tool = {
    name: "grepFiles",
    description:
      "Search for a literal substring across files. Results are limited in size — narrow the search with a glob. Useful for finding navigation calls (e.g. 'router.push', 'Navigator.push') across the codebase.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Literal substring to search for (not a regex).",
        },
        glob: {
          type: "string",
          description:
            "Optional glob to restrict the search (e.g. 'src/**/*.tsx'). Strongly recommended for large repos.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    skipPermission: true,
    handler: (args) => handleGrepFiles(ctx, coerceGrepFilesArgs(args)),
  };

  return [readFileTool, searchFilesTool, grepFilesTool];
}

// ---------------------------------------------------------------------------
// Argument coercion — the Copilot SDK delivers tool arguments as `unknown`.
// These helpers narrow them to the typed shapes our handlers expect and fall
// back to empty strings / undefined when the model sends something unexpected.
// ---------------------------------------------------------------------------

function getStringProp(obj: unknown, key: string): string {
  if (typeof obj !== "object" || obj === null) return "";
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "string" ? val : "";
}

function getOptionalStringProp(obj: unknown, key: string): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "string" ? val : undefined;
}

export function coerceReadFileArgs(args: unknown): ReadFileArgs {
  return { path: getStringProp(args, "path") };
}

export function coerceSearchFilesArgs(args: unknown): SearchFilesArgs {
  return { pattern: getStringProp(args, "pattern") };
}

export function coerceGrepFilesArgs(args: unknown): GrepFilesArgs {
  return {
    query: getStringProp(args, "query"),
    glob: getOptionalStringProp(args, "glob"),
  };
}
