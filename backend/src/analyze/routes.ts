/**
 * Analysis API Routes (SSE Progress)
 *
 * POST /api/analyze       — Start an analysis job, returns { jobId }
 * GET  /api/analyze/:jobId — SSE stream for progress events
 *
 * Reference: SPEC.md §6.1, §6.2, §6.3
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { decrypt } from "../auth/crypto.js";
import { detectFramework } from "../analysis/framework-detector.js";
import {
  fetchFileTree,
  filterFilesByPatterns,
  fetchFileContents,
} from "../analysis/github-file-fetcher.js";
import {
  AnalysisPipeline,
  isSupportedModel,
  DEFAULT_MODEL,
} from "../analysis/analysis-pipeline.js";
import type { SupportedModel } from "../analysis/analysis-pipeline.js";
import type { CopilotClientManager } from "../analysis/copilot-client.js";
import { JobManager } from "./job-manager.js";
import type { PackageJson } from "../analysis/framework-detector.js";

// ---------------------------------------------------------------------------
// Request body shape
// ---------------------------------------------------------------------------

interface AnalyzeRequestBody {
  owner?: string;
  repo?: string;
  branch?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface AnalyzeRouterDeps {
  clientManager: CopilotClientManager;
  jobManager?: JobManager;
}

export function createAnalyzeRouter(deps: AnalyzeRouterDeps): Router {
  const router = Router();
  const jobManager = deps.jobManager ?? new JobManager();

  // POST /api/analyze — Start analysis job
  router.post("/", (req: Request, res: Response) => {
    const body = req.body as AnalyzeRequestBody;

    // Validate required fields
    if (!body.owner || !body.repo || !body.branch) {
      res.status(400).json({
        error: "validation_error",
        message: "owner, repo, and branch are required",
      });
      return;
    }

    // Validate model if provided
    const model: SupportedModel =
      body.model && isSupportedModel(body.model)
        ? (body.model as SupportedModel)
        : DEFAULT_MODEL;

    const userId = req.session.user!.login;
    const jobId = jobManager.createJob(userId);

    if (jobId === null) {
      res.status(429).json({
        error: "too_many_jobs",
        message: "Too many active analysis jobs. Please wait for existing jobs to complete.",
      });
      return;
    }

    // Return jobId immediately
    res.status(202).json({ jobId });

    // Run the pipeline in the background
    runPipeline({
      jobId,
      userId,
      owner: body.owner,
      repo: body.repo,
      branch: body.branch,
      model,
      encryptedToken: req.session.encryptedToken!,
      jobManager,
      clientManager: deps.clientManager,
    }).catch((err) => {
      console.error(
        `[analyze] Unhandled pipeline error for job ${jobId}:`,
        err,
      );
    });
  });

  // GET /api/analyze/:jobId — SSE stream
  router.get("/:jobId", (req: Request, res: Response) => {
    const jobId = req.params["jobId"] as string;
    const job = jobManager.getJob(jobId);

    if (!job) {
      res.status(404).json({
        error: "not_found",
        message: "Job not found",
      });
      return;
    }

    // Verify ownership
    const userId = req.session.user!.login;
    if (job.userId !== userId) {
      res.status(403).json({
        error: "forbidden",
        message: "Access denied",
      });
      return;
    }

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();

    // If job already completed, send the result immediately
    if (job.status === "complete" && job.result) {
      res.write(`event: complete\ndata: ${JSON.stringify(job.result)}\n\n`);
      res.end();
      return;
    }

    // If job already errored, send the error immediately
    if (job.status === "error" && job.error) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: job.error })}\n\n`,
      );
      res.end();
      return;
    }

    // Register the SSE connection
    jobManager.addConnection(jobId, res);

    // Clean up on client disconnect
    req.on("close", () => {
      jobManager.removeConnection(jobId, res);
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Background pipeline runner
// ---------------------------------------------------------------------------

interface PipelineParams {
  jobId: string;
  userId: string;
  owner: string;
  repo: string;
  branch: string;
  model: SupportedModel;
  encryptedToken: string;
  jobManager: JobManager;
  clientManager: CopilotClientManager;
}

async function runPipeline(params: PipelineParams): Promise<void> {
  const {
    jobId,
    userId,
    owner,
    repo,
    branch,
    model,
    encryptedToken,
    jobManager,
    clientManager,
  } = params;

  try {
    const token = decrypt(encryptedToken);

    // Step 1: Detect framework
    jobManager.sendProgress(jobId, {
      step: "detecting_framework",
      message: "フレームワークを検出中...",
    });

    const { files: allFiles } = await fetchFileTree(owner, repo, branch, token);
    const allPaths = allFiles.map((f) => f.path);

    // Find and parse package.json
    const pkgEntry = allFiles.find((f) => f.path === "package.json");
    if (!pkgEntry) {
      jobManager.sendError(jobId, "package.json not found in repository root");
      return;
    }

    const pkgContents = await fetchFileContents(
      owner,
      repo,
      [pkgEntry],
      token,
      {
        ref: branch,
      },
    );

    if (!pkgContents[0]) {
      jobManager.sendError(jobId, "Failed to fetch package.json contents");
      return;
    }

    let packageJson: PackageJson;
    try {
      packageJson = JSON.parse(pkgContents[0].content) as PackageJson;
    } catch {
      jobManager.sendError(
        jobId,
        "package.json contains invalid JSON and could not be parsed",
      );
      return;
    }

    const { framework, routingFilePatterns } = detectFramework(
      packageJson,
      allPaths,
    );

    // Step 2: Fetch files
    jobManager.sendProgress(jobId, {
      step: "fetching_files",
      message: "ファイルを取得中...",
    });

    const routingEntries = filterFilesByPatterns(allFiles, routingFilePatterns);
    const routingFiles = await fetchFileContents(
      owner,
      repo,
      routingEntries,
      token,
      { ref: branch },
    );

    // Fetch component files (all .ts/.tsx/.js/.jsx/.vue/.svelte files)
    // excluding common non-source directories
    const EXCLUDED_DIR_PREFIXES = [
      "node_modules/",
      "dist/",
      "build/",
      ".next/",
      "out/",
      ".nuxt/",
      ".svelte-kit/",
    ];
    const componentPatterns = [
      "**/*.tsx",
      "**/*.jsx",
      "**/*.ts",
      "**/*.js",
      "**/*.vue",
      "**/*.svelte",
    ];
    const componentEntries = filterFilesByPatterns(
      allFiles,
      componentPatterns,
    ).filter(
      (f) => !EXCLUDED_DIR_PREFIXES.some((prefix) => f.path.startsWith(prefix)),
    );
    const componentFiles = await fetchFileContents(
      owner,
      repo,
      componentEntries,
      token,
      { ref: branch },
    );

    // Step 3: Analyze routes (Turn 1)
    jobManager.sendProgress(jobId, {
      step: "analyzing_routes",
      message: "ルートを解析中...",
    });

    const adapter = clientManager.getClient(userId, token);
    const pipeline = new AnalysisPipeline(adapter);

    const result = await pipeline.run({
      framework,
      routingFiles,
      componentFiles,
      model,
      onProgress: (stage) => {
        if (stage === "analyzing_variants") {
          jobManager.sendProgress(jobId, {
            step: "analyzing_variants",
            message: "バリエーションを解析中...",
          });
        } else if (stage === "analyzing_transitions") {
          jobManager.sendProgress(jobId, {
            step: "analyzing_transitions",
            message: "画面遷移を解析中...",
          });
        }
      },
    });

    // Send complete event
    jobManager.sendComplete(jobId, result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Analysis failed unexpectedly";
    jobManager.sendError(jobId, message);
  }
}
