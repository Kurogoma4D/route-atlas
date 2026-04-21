/**
 * Copilot Custom Tools for On-Demand File Exploration
 *
 * Defines custom tools that Copilot can invoke during a chat turn to fetch
 * repository content on demand, rather than embedding entire file contents
 * in the prompt up front. This keeps token usage bounded on large repositories.
 *
 * Three tools are exposed:
 *   - `readFile(path)`                — fetch a single file via GitHub Contents / Blob API
 *   - `searchFiles(pattern)`          — glob-match paths from the pre-fetched file tree
 *   - `grepFiles(query, glob?)`       — case-insensitive substring search over known file contents
 *
 * Reference: issue #90
 */

import { Minimatch } from "minimatch";
import type { Tool } from "@github/copilot-sdk";
import {
  fetchSingleFileContent,
  GitHubApiError,
  GitHubRateLimitError,
  type TreeEntry,
} from "./github-file-fetcher.js";

// ---------------------------------------------------------------------------
// Tool argument shapes
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

// ---------------------------------------------------------------------------
// Tool context — data the tools need to operate
// ---------------------------------------------------------------------------

/**
 * Contextual data required to build a set of file tools for one analysis run.
 *
 * `fileTree` is the pre-fetched, filtered list of blob entries for the
 * repository. `readFile` only accepts paths that appear in this list (to
 * protect against prompt injection requesting unrelated paths).
 *
 * `preloadedContents` maps already-fetched file paths to their decoded text.
 * It is the preferred source for `readFile` and is used by `grepFiles`.
 * Tools fetch from the GitHub API only if a requested file isn't preloaded.
 */
export interface FileToolContext {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** Complete blob list for the repo (already filtered to relevant extensions). */
  fileTree: TreeEntry[];
  /** Map of path -> decoded content for files already fetched upstream. */
  preloadedContents: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Limits — defensive caps to keep prompt roundtrips bounded
// ---------------------------------------------------------------------------

/** Maximum number of paths returned by `searchFiles`. */
export const SEARCH_FILES_MAX_RESULTS = 100;

/** Maximum number of grep matches returned. */
export const GREP_FILES_MAX_RESULTS = 50;

/**
 * Maximum per-file size (characters) that `grepFiles` will scan.
 * Very large preloaded files are skipped to keep regex / substring scan
 * times bounded — a single 50 MB minified bundle could otherwise dominate a
 * grep invocation.
 */
export const GREP_FILES_MAX_FILE_BYTES = 1_000_000;

/**
 * Maximum file size (bytes) that `readFile` will fetch on demand.
 * Larger files are truncated to this length and annotated with a marker.
 */
export const READ_FILE_MAX_BYTES = 200_000;

/**
 * Maximum length (characters) of a glob pattern passed to `searchFiles` or
 * `grepFiles`. LLM-supplied patterns are passed to `minimatch`, which compiles
 * them into regexes; adversarially long or complex patterns could induce
 * blocking event-loop stalls. We cap the pattern length defensively.
 */
export const MAX_GLOB_PATTERN_LENGTH = 200;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function truncateContent(content: string): string {
  if (content.length <= READ_FILE_MAX_BYTES) return content;
  return (
    content.slice(0, READ_FILE_MAX_BYTES) +
    `\n/* [route-atlas] truncated after ${READ_FILE_MAX_BYTES} bytes */`
  );
}

function formatToolError(prefix: string, err: unknown): string {
  if (err instanceof GitHubRateLimitError) {
    return `Error: GitHub API rate limit hit while ${prefix}. Retry after ${err.retryAfterSeconds}s.`;
  }
  if (err instanceof GitHubApiError) {
    if (err.status === 404) {
      return `Error: ${prefix} — file not found (HTTP 404).`;
    }
    return `Error: ${prefix} — GitHub API returned HTTP ${err.status}.`;
  }
  if (err instanceof Error) {
    return `Error: ${prefix} — ${err.message}`;
  }
  return `Error: ${prefix} — unknown failure.`;
}

function isReadFileArgs(v: unknown): v is ReadFileArgs {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { path?: unknown }).path === "string"
  );
}

function isSearchFilesArgs(v: unknown): v is SearchFilesArgs {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { pattern?: unknown }).pattern === "string"
  );
}

function isGrepFilesArgs(v: unknown): v is GrepFilesArgs {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as { query?: unknown; glob?: unknown };
  if (typeof obj.query !== "string") return false;
  if (obj.glob !== undefined && typeof obj.glob !== "string") return false;
  return true;
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

/**
 * Build a `readFile` tool that fetches a single file's text content.
 *
 * The tool first consults the preloaded cache, then falls back to a GitHub
 * Contents/Blob API call. Requested paths must exist in `fileTree`.
 *
 * The return type is `Tool<unknown>` because the handler validates its
 * arguments at runtime from an `unknown` payload — this matches how the SDK
 * invokes tool handlers and keeps the type structurally compatible with
 * {@link ChatCompletionOptions.tools}.
 */
export function createReadFileTool(ctx: FileToolContext): Tool<unknown> {
  // Pre-index the file tree by path so each readFile call is O(1).
  // The model may invoke readFile many times per analysis run; a linear scan
  // per call would be O(n) in the full tree for every invocation.
  const fileTreeByPath = new Map<string, TreeEntry>();
  for (const entry of ctx.fileTree) {
    fileTreeByPath.set(entry.path, entry);
  }

  return {
    name: "readFile",
    description:
      "Read the text contents of a single file from the repository. " +
      "Use this when you need the full source of a file to analyze routes, " +
      "components, or navigation. Pass the exact path as returned by the " +
      "file list or searchFiles. Returns the file content, or an error string " +
      "starting with 'Error:' if the file is not in the repository.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Repository-relative file path, e.g. 'src/app/page.tsx'.",
        },
      },
      required: ["path"],
    },
    skipPermission: true,
    handler: async (args: unknown): Promise<string> => {
      if (!isReadFileArgs(args)) {
        return "Error: readFile requires a { path: string } argument.";
      }

      const path = args.path.trim();
      if (path.length === 0) {
        return "Error: readFile 'path' must be a non-empty string.";
      }

      // Preloaded cache hit
      const cached = ctx.preloadedContents.get(path);
      if (cached !== undefined) {
        return truncateContent(cached);
      }

      // The file must exist in the pre-fetched tree
      const entry = fileTreeByPath.get(path);
      if (!entry) {
        return `Error: readFile — '${path}' is not in the repository file list.`;
      }

      try {
        const content = await fetchSingleFileContent(
          ctx.owner,
          ctx.repo,
          entry,
          ctx.token,
          ctx.branch,
        );
        ctx.preloadedContents.set(path, content);
        return truncateContent(content);
      } catch (err) {
        return formatToolError(`reading '${path}'`, err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// searchFiles
// ---------------------------------------------------------------------------

/**
 * Build a `searchFiles` tool that glob-matches paths against the file tree.
 *
 * The match runs purely against the pre-fetched `fileTree`, so it is fast and
 * rate-limit-free. Results are capped at {@link SEARCH_FILES_MAX_RESULTS}.
 */
export function createSearchFilesTool(ctx: FileToolContext): Tool<unknown> {
  return {
    name: "searchFiles",
    description:
      "Find repository file paths matching a glob pattern. Use '**' to " +
      "recurse across directories, e.g. 'src/**/*.tsx'. Returns a newline-" +
      "separated list of matching paths (capped at " +
      `${SEARCH_FILES_MAX_RESULTS} entries).`,
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, e.g. 'app/**/page.{tsx,jsx}'.",
        },
      },
      required: ["pattern"],
    },
    skipPermission: true,
    handler: (args: unknown): string => {
      if (!isSearchFilesArgs(args)) {
        return "Error: searchFiles requires a { pattern: string } argument.";
      }

      const pattern = args.pattern.trim();
      if (pattern.length === 0) {
        return "Error: searchFiles 'pattern' must be a non-empty string.";
      }
      if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
        return `Error: searchFiles 'pattern' must be at most ${MAX_GLOB_PATTERN_LENGTH} characters.`;
      }

      // Compile the glob once, then match each file-tree entry against the
      // compiled matcher. Calling `minimatch(path, pattern)` per entry would
      // re-parse the glob N times.
      const mm = new Minimatch(pattern);
      const matches: string[] = [];
      for (const entry of ctx.fileTree) {
        if (mm.match(entry.path)) {
          matches.push(entry.path);
          if (matches.length >= SEARCH_FILES_MAX_RESULTS) break;
        }
      }

      if (matches.length === 0) {
        return `No files match pattern '${pattern}'.`;
      }
      return matches.join("\n");
    },
  };
}

// ---------------------------------------------------------------------------
// grepFiles
// ---------------------------------------------------------------------------

/**
 * Build a `grepFiles` tool that searches the preloaded file contents for a
 * (case-insensitive) literal substring, optionally restricted by a glob.
 *
 * Scope is limited to {@link FileToolContext.preloadedContents}. If a file
 * you want to search isn't loaded yet, call `readFile` on it first. This
 * keeps the tool rate-limit-free and fast.
 */
export function createGrepFilesTool(ctx: FileToolContext): Tool<unknown> {
  // Cache line-split arrays per file so repeated grepFiles invocations within
  // one analysis run don't re-split the same large files over and over.
  // Each cache entry stores both the raw lines AND their pre-lowercased form
  // so repeated greps pay the lowercasing cost only once per file+line.
  interface GrepLines {
    raw: string[];
    lower: string[];
  }
  const splitCache = new Map<string, GrepLines>();

  function getLines(path: string, content: string): GrepLines {
    const cached = splitCache.get(path);
    if (cached !== undefined) return cached;
    const raw = content.split("\n");
    const lower = raw.map((line) => line.toLowerCase());
    const entry: GrepLines = { raw, lower };
    splitCache.set(path, entry);
    return entry;
  }

  return {
    name: "grepFiles",
    description:
      "Search previously-read files for a case-insensitive substring. " +
      "Returns up to " +
      `${GREP_FILES_MAX_RESULTS} lines of the form 'path:lineNo:text'. ` +
      "Only files that have been fetched (either preloaded or via readFile) " +
      "are searched. Files larger than " +
      `${GREP_FILES_MAX_FILE_BYTES} bytes are skipped to keep scan times ` +
      "bounded. Use the optional 'glob' argument to narrow the scope " +
      "(e.g. 'src/**/*.tsx').",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Literal text to search for (case-insensitive).",
        },
        glob: {
          type: "string",
          description: "Optional glob to limit files, e.g. 'app/**/*.tsx'.",
        },
      },
      required: ["query"],
    },
    skipPermission: true,
    handler: (args: unknown): string => {
      if (!isGrepFilesArgs(args)) {
        return "Error: grepFiles requires a { query: string, glob?: string } argument.";
      }

      const query = args.query.trim();
      if (query.length === 0) {
        return "Error: grepFiles 'query' must be a non-empty string.";
      }
      if (
        args.glob !== undefined &&
        args.glob.length > MAX_GLOB_PATTERN_LENGTH
      ) {
        return `Error: grepFiles 'glob' must be at most ${MAX_GLOB_PATTERN_LENGTH} characters.`;
      }

      const lowered = query.toLowerCase();
      const matches: string[] = [];
      // Compile the glob once up-front rather than re-parsing it per-entry.
      const globMatcher =
        args.glob !== undefined ? new Minimatch(args.glob) : null;

      for (const [path, content] of ctx.preloadedContents) {
        if (globMatcher && !globMatcher.match(path)) continue;
        // Skip pathologically large files to bound scan time.
        if (content.length > GREP_FILES_MAX_FILE_BYTES) continue;

        const { raw, lower } = getLines(path, content);
        for (let i = 0; i < raw.length; i++) {
          if (lower[i].includes(lowered)) {
            matches.push(`${path}:${i + 1}:${raw[i].trim()}`);
            if (matches.length >= GREP_FILES_MAX_RESULTS) break;
          }
        }
        if (matches.length >= GREP_FILES_MAX_RESULTS) break;
      }

      if (matches.length === 0) {
        return `No matches for '${query}'${args.glob ? ` (glob: ${args.glob})` : ""} in the currently-loaded files.`;
      }
      return matches.join("\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Convenience: build all three tools for a context
// ---------------------------------------------------------------------------

/**
 * Build the full set of file-exploration tools for an analysis run.
 *
 * The return type is `Tool<unknown>[]` because each tool's handler validates
 * its arguments at runtime from `unknown` (see the `is*Args` guards above).
 * This matches how the tools are consumed by {@link ChatCompletionOptions},
 * avoiding unsafe casts through `unknown`.
 */
export function createFileTools(ctx: FileToolContext): Tool<unknown>[] {
  return [
    createReadFileTool(ctx),
    createSearchFilesTool(ctx),
    createGrepFilesTool(ctx),
  ];
}
