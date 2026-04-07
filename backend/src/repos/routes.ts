import { Hono } from "hono";
import type { Context } from "hono";
import { decrypt } from "../auth/crypto.js";
import type {
  RepoInfo,
  BranchInfo,
  ReposResponse,
  BranchesResponse,
} from "@route-atlas/shared";

const GITHUB_API_BASE = "https://api.github.com";

async function getAccessToken(c: Context): Promise<string> {
  const session = c.get("session");
  const encryptedToken = session?.encryptedToken;
  if (!encryptedToken) {
    throw new Error("No encrypted token in session");
  }
  return await decrypt(encryptedToken);
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  default_branch: string;
  language: string | null;
  updated_at: string;
  html_url: string;
}

interface GitHubBranch {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

function mapRepo(repo: GitHubRepo): RepoInfo {
  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner.login,
    description: repo.description,
    private: repo.private,
    defaultBranch: repo.default_branch,
    language: repo.language,
    updatedAt: repo.updated_at,
    htmlUrl: repo.html_url,
  };
}

function mapBranch(branch: GitHubBranch): BranchInfo {
  return {
    name: branch.name,
    commit: branch.commit.sha,
    protected: branch.protected,
  };
}

/**
 * Parse the GitHub Link header to determine if there is a next page.
 * Returns true if a rel="next" link is present.
 */
function hasNextPageFromLink(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return linkHeader.includes('rel="next"');
}

export function createReposRouter(): Hono {
  const router = new Hono();

  // GET /api/repos — List user's repositories
  router.get("/", async (c) => {
    try {
      const token = await getAccessToken(c);
      const page = Math.max(parseInt(c.req.query("page") ?? "") || 1, 1);
      const perPage = Math.min(
        Math.max(parseInt(c.req.query("per_page") ?? "") || 30, 1),
        100,
      );

      const url = new URL(`${GITHUB_API_BASE}/user/repos`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("sort", "updated");
      url.searchParams.set("direction", "desc");
      url.searchParams.set(
        "affiliation",
        "owner,collaborator,organization_member",
      );

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "route-atlas/1.0",
        },
      });

      if (!response.ok) {
        return c.json(
          {
            error: "github_api_error",
            message: "Failed to fetch repositories",
          },
          response.status as 400 | 401 | 403 | 404 | 500,
        );
      }

      const repos = (await response.json()) as GitHubRepo[];
      const linkHeader = response.headers.get("link");
      const hasNext = hasNextPageFromLink(linkHeader);

      const result: ReposResponse = {
        repos: repos.map(mapRepo),
        page,
        perPage,
        hasNextPage: hasNext,
      };

      return c.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch repositories";
      return c.json({ error: "internal_error", message }, 500);
    }
  });

  // GET /api/repos/:owner/:repo/branches — List branches for a repository
  router.get("/:owner/:repo/branches", async (c) => {
    try {
      const token = await getAccessToken(c);
      const owner = c.req.param("owner");
      const repo = c.req.param("repo");

      const url = new URL(
        `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
      );
      url.searchParams.set("per_page", "100");

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "route-atlas/1.0",
        },
      });

      if (!response.ok) {
        return c.json(
          {
            error: "github_api_error",
            message: "Failed to fetch branches",
          },
          response.status as 400 | 401 | 403 | 404 | 500,
        );
      }

      const branches = (await response.json()) as GitHubBranch[];

      const result: BranchesResponse = {
        branches: branches.map(mapBranch),
      };

      return c.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch branches";
      return c.json({ error: "internal_error", message }, 500);
    }
  });

  return router;
}
