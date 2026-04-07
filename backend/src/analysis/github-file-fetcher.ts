/**
 * GitHub API File Fetching Module
 *
 * Fetches repository file trees and file contents from the GitHub REST API.
 * Handles large repositories (truncated trees), files over 1MB (Blob API),
 * and GitHub API rate limiting with exponential backoff.
 *
 * Reference: SPEC.md §5.3
 */

import { minimatch } from "minimatch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry returned by the GitHub Git Trees API. */
export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
  url: string;
}

/** Response shape of `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`. */
export interface TreeResponse {
  sha: string;
  url: string;
  tree: TreeEntry[];
  truncated: boolean;
}

/** Response shape of `GET /repos/{owner}/{repo}/contents/{path}` for a file. */
export interface ContentsResponse {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file";
  content: string;
  encoding: "base64";
}

/** Response shape of `GET /repos/{owner}/{repo}/git/blobs/{sha}`. */
export interface BlobResponse {
  sha: string;
  content: string;
  encoding: "base64" | "utf-8";
  size: number;
}

/** A file with its contents resolved to a string. */
export interface FileWithContent {
  path: string;
  content: string;
}

/** Thrown when the GitHub API returns a rate-limit error after all retries. */
export class GitHubRateLimitError extends Error {
  public readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      `GitHub API rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
    );
    this.name = "GitHubRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Thrown when the GitHub API returns an unexpected error. */
export class GitHubApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(`GitHub API error (${status}): ${message}`);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";

/** Maximum number of retries on rate-limit (HTTP 403 / 429). */
const MAX_RETRIES = 3;

/** Base delay (ms) for exponential backoff between retries. */
const BASE_BACKOFF_MS = 1000;

/** Contents API file size limit (1 MB). Files larger need Blob API. */
const CONTENTS_API_SIZE_LIMIT = 1_000_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Perform a GET request to the GitHub API with authentication, rate-limit
 * handling, and exponential backoff on 403/429.
 */
export async function githubFetch<T>(
  url: string,
  token: string,
  retries = MAX_RETRIES,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "route-atlas/1.0",
      },
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    // Rate limit handling
    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      const retryAfterHeader = response.headers.get("retry-after");
      const rateLimitResetHeader = response.headers.get("x-ratelimit-reset");

      let waitMs: number;
      if (retryAfterHeader) {
        waitMs = parseInt(retryAfterHeader, 10) * 1000;
      } else if (rateLimitResetHeader) {
        const resetEpoch = parseInt(rateLimitResetHeader, 10) * 1000;
        waitMs = Math.max(resetEpoch - Date.now(), 0);
      } else {
        waitMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
      }

      if (attempt < retries) {
        await sleepFn(waitMs);
        continue;
      }

      // All retries exhausted
      throw new GitHubRateLimitError(Math.ceil(waitMs / 1000));
    }

    // Non-rate-limit error — throw immediately
    const body = await response.text();
    throw new GitHubApiError(response.status, body);
  }

  // Should be unreachable, but satisfies TypeScript
  throw new GitHubApiError(500, "Unexpected: retry loop exited without return");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the file tree of a repository at a given branch.
 *
 * Uses `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`.
 * Returns only blob entries (files, not sub-trees).
 */
export async function fetchFileTree(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<{ files: TreeEntry[]; truncated: boolean }> {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const data = await githubFetch<TreeResponse>(url, token);

  const files = data.tree.filter((entry) => entry.type === "blob");
  return { files, truncated: data.truncated };
}

/**
 * Filter tree entries by an array of glob patterns.
 *
 * Each pattern is tested against the file path using minimatch.
 * A file is included if it matches **any** of the patterns.
 */
export function filterFilesByPatterns(
  files: TreeEntry[],
  patterns: string[],
): TreeEntry[] {
  if (patterns.length === 0) return [];

  return files.filter((file) =>
    patterns.some((pattern) => minimatch(file.path, pattern)),
  );
}

/**
 * Fetch the text content of a single file from a repository.
 *
 * For files within the 1 MB Contents API limit, uses
 * `GET /repos/{owner}/{repo}/contents/{path}`.
 *
 * For files exceeding 1 MB, or when the Contents API returns 403, falls back to
 * `GET /repos/{owner}/{repo}/git/blobs/{sha}`.
 */
export async function fetchSingleFileContent(
  owner: string,
  repo: string,
  file: TreeEntry,
  token: string,
  ref?: string,
): Promise<string> {
  const isLargeFile =
    file.size !== undefined && file.size > CONTENTS_API_SIZE_LIMIT;

  if (isLargeFile) {
    return fetchViaBlobApi(owner, repo, file.sha, token);
  }

  // Use Contents API
  const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
  const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${refParam}`;

  try {
    const data = await githubFetch<ContentsResponse>(url, token);
    return decodeBase64Content(data.content);
  } catch (err) {
    // If Contents API fails with 403 (too large), fall back to Blob API
    if (err instanceof GitHubApiError && err.status === 403) {
      return fetchViaBlobApi(owner, repo, file.sha, token);
    }
    throw err;
  }
}

/**
 * Fetch file contents for multiple files.
 *
 * Files exceeding the Contents API size limit are automatically fetched
 * via the Blob API.
 */
export async function fetchFileContents(
  owner: string,
  repo: string,
  files: TreeEntry[],
  token: string,
  options?: { ref?: string },
): Promise<FileWithContent[]> {
  const results: FileWithContent[] = [];

  for (const file of files) {
    const content = await fetchSingleFileContent(
      owner,
      repo,
      file,
      token,
      options?.ref,
    );
    results.push({ path: file.path, content });
  }

  return results;
}

/**
 * Fetch file content via the Blob API.
 *
 * Used for files exceeding 1 MB or when the tree is truncated.
 * `GET /repos/{owner}/{repo}/git/blobs/{sha}`
 */
export async function fetchViaBlobApi(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`;
  const data = await githubFetch<BlobResponse>(url, token);

  if (data.encoding === "base64") {
    return decodeBase64Content(data.content);
  }

  // utf-8 encoding — return as-is
  return data.content;
}

/**
 * Decode a base64-encoded string (as returned by the GitHub API).
 * GitHub splits base64 content across lines, so we strip whitespace first.
 */
export function decodeBase64Content(encoded: string): string {
  const cleaned = encoded.replace(/\s/g, "");
  return Buffer.from(cleaned, "base64").toString("utf-8");
}
