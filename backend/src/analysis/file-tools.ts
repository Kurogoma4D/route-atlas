/**
 * Custom Copilot SDK Tools for On-Demand File Access
 *
 * Instead of embedding every potentially relevant file into the prompt, we
 * expose a small set of tools that allow Copilot to fetch exactly the files
 * it needs during analysis:
 *
 *   - readFile({ path })      — fetch a single file's contents
 *   - searchFiles({ pattern })— list files whose path matches a glob pattern
 *   - grepFiles({ query, glob? }) — find files whose contents contain `query`
 *
 * The tools operate against an in-memory list of tree entries (so path search
 * is free) and fall back to the GitHub Blob / Contents APIs for the actual
 * file payloads. A per-session cache avoids re-fetching the same file.
 *
 * Reference: Issue #90 — delegate file exploration to the LLM.
 */
import { minimatch } from "minimatch";
import { defineTool, type Tool } from "@github/copilot-sdk";
import {
  fetchSingleFileContent,
  GitHubApiError,
  GitHubRateLimitError,
  type TreeEntry,
} from "./github-file-fetcher.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum number of characters returned for a single tool result. */
const MAX_TOOL_PAYLOAD_CHARS = 60_000;

/** Maximum number of matches returned by `searchFiles` / `grepFiles`. */
const MAX_SEARCH_RESULTS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileToolsContext {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** The full tree of files available in the repo (blobs only). */
  files: TreeEntry[];
}

export interface FileToolsOptions {
  /**
   * Optional fetcher used to read a single file's contents. Injectable so
   * tests can stub out the GitHub API.
   */
  fetchSingleFile?: (
    owner: string,
    repo: string,
    entry: TreeEntry,
    token: string,
    ref?: string,
  ) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keep a tool response under the payload cap so we never overflow the context. */
function truncate(text: string, limit = MAX_TOOL_PAYLOAD_CHARS): string {
  if (text.length <= limit) return text;
  const truncated = text.slice(0, limit);
  return `${truncated}\n\n[... truncated ${text.length - limit} characters. File is too large to include in full; call readFile again with a narrower focus or use grepFiles to locate specific regions.]`;
}

/**
 * Normalise arbitrary `unknown` tool arguments into a record.
 * Copilot SDK passes arguments through as `unknown`, so we must narrow
 * manually before accessing fields.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = record[key];
  return typeof v === "string" ? v : undefined;
}

function formatError(prefix: string, err: unknown): string {
  if (err instanceof GitHubRateLimitError) {
    return `${prefix}: GitHub rate limit exceeded. Retry after ${err.retryAfterSeconds}s. Avoid unnecessary calls for a moment and try again.`;
  }
  if (err instanceof GitHubApiError) {
    if (err.status === 404) return `${prefix}: file not found.`;
    return `${prefix}: GitHub API error ${err.status}.`;
  }
  if (err instanceof Error) return `${prefix}: ${err.message}`;
  return `${prefix}: unknown error`;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build the three file-access tools bound to a given repository context.
 *
 * The returned tools are stateless from the caller's perspective, but share
 * an internal cache so Copilot pays for each unique file at most once per
 * analysis run.
 */
export function createFileTools(
  context: FileToolsContext,
  options: FileToolsOptions = {},
): Tool<unknown>[] {
  const fetchFile = options.fetchSingleFile ?? fetchSingleFileContent;
  const contentCache = new Map<string, string>();
  const fileByPath = new Map<string, TreeEntry>();
  for (const entry of context.files) {
    fileByPath.set(entry.path, entry);
  }

  async function getContent(entry: TreeEntry): Promise<string> {
    const cached = contentCache.get(entry.path);
    if (cached !== undefined) return cached;
    const content = await fetchFile(
      context.owner,
      context.repo,
      entry,
      context.token,
      context.branch,
    );
    contentCache.set(entry.path, content);
    return content;
  }

  // -------------------------------------------------------------------------
  // readFile
  // -------------------------------------------------------------------------
  const readFile = defineTool("readFile", {
    description:
      "Read the text contents of a single file from the repository. The `path` must match a file path from the repository tree exactly.",
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
      additionalProperties: false,
    },
    handler: async (args: unknown) => {
      const path = readString(asRecord(args), "path");
      if (!path) {
        return "Error: `path` is required and must be a string.";
      }
      const entry = fileByPath.get(path);
      if (!entry) {
        return `Error: file '${path}' is not present in the repository file tree.`;
      }
      try {
        const content = await getContent(entry);
        return truncate(`File: ${path}\n\n${content}`);
      } catch (err) {
        return formatError(`Error reading '${path}'`, err);
      }
    },
  });

  // -------------------------------------------------------------------------
  // searchFiles
  // -------------------------------------------------------------------------
  const searchFiles = defineTool("searchFiles", {
    description:
      "Return a list of repository file paths that match the given glob pattern (e.g. 'src/**/*.tsx', 'app/**/page.*'). Use this to discover files before reading them.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match file paths against.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    handler: (args: unknown) => {
      const pattern = readString(asRecord(args), "pattern");
      if (!pattern) {
        return "Error: `pattern` is required and must be a string.";
      }
      const matches: string[] = [];
      for (const entry of context.files) {
        if (minimatch(entry.path, pattern)) {
          matches.push(entry.path);
          if (matches.length >= MAX_SEARCH_RESULTS) break;
        }
      }
      if (matches.length === 0) {
        return `No files matched pattern '${pattern}'.`;
      }
      const header =
        matches.length >= MAX_SEARCH_RESULTS
          ? `Showing first ${MAX_SEARCH_RESULTS} matches for '${pattern}':`
          : `${matches.length} file(s) matched '${pattern}':`;
      return truncate(`${header}\n${matches.join("\n")}`);
    },
  });

  // -------------------------------------------------------------------------
  // grepFiles
  // -------------------------------------------------------------------------
  const grepFiles = defineTool("grepFiles", {
    description:
      "Search file contents for the given query string. Optionally restrict the scan to files matching `glob`. Returns up to a few matching lines per file. Prefer a specific `glob` to keep the scan cheap.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Substring to search for (case-sensitive).",
        },
        glob: {
          type: "string",
          description:
            "Optional glob to restrict the scan (e.g. 'src/**/*.ts').",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args: unknown) => {
      const record = asRecord(args);
      const query = readString(record, "query");
      const glob = readString(record, "glob");
      if (!query) {
        return "Error: `query` is required and must be a string.";
      }

      const candidates = context.files.filter(
        (entry) => !glob || minimatch(entry.path, glob),
      );

      if (candidates.length === 0) {
        return glob
          ? `No files matched glob '${glob}'.`
          : "No files available to scan.";
      }

      const results: string[] = [];
      let totalMatches = 0;

      for (const entry of candidates) {
        let content: string;
        try {
          content = await getContent(entry);
        } catch (err) {
          if (err instanceof GitHubRateLimitError) {
            return formatError("Error during grep", err);
          }
          if (err instanceof GitHubApiError && err.status === 404) {
            continue;
          }
          return formatError("Error during grep", err);
        }
        const lines = content.split("\n");
        const hits: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(query)) {
            hits.push(`  L${i + 1}: ${lines[i].trim()}`);
            if (hits.length >= 3) break;
          }
        }
        if (hits.length > 0) {
          totalMatches += hits.length;
          results.push(`### ${entry.path}\n${hits.join("\n")}`);
          if (results.length >= MAX_SEARCH_RESULTS) break;
        }
      }

      if (results.length === 0) {
        const scope = glob ? ` under '${glob}'` : "";
        return `No matches for '${query}'${scope} (scanned ${candidates.length} file(s)).`;
      }

      const header = `${totalMatches} match(es) for '${query}' across ${results.length} file(s) (scanned ${candidates.length} file(s)):`;
      return truncate(`${header}\n\n${results.join("\n\n")}`);
    },
  });

  return [readFile, searchFiles, grepFiles];
}
