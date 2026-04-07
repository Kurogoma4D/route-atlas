/**
 * Analysis API Routes (SSE Progress)
 *
 * POST /api/analyze              — Start an analysis job, returns { jobId }
 * GET  /api/analyze/:jobId        — SSE stream for progress events
 * GET  /api/analyze/:jobId/result — Retrieve completed analysis result as JSON
 *
 * Reference: SPEC.md §6.1, §6.2, §6.3
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { decrypt } from "../auth/crypto.js";
import {
  detectFramework,
  detectPlatform,
  detectAndroidFramework,
  detectiOSFramework,
  detectFlutterFramework,
  isAndroidFramework,
  isIOSFramework,
  isFlutterFramework,
  isExcludedPath,
} from "../analysis/framework-detector.js";
import type { FrameworkDetectionResult } from "../analysis/framework-detector.js";
import { FLUTTER_EXCLUDED_FILE_PATTERNS } from "../analysis/constants.js";
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
        message:
          "Too many active analysis jobs. Please wait for existing jobs to complete.",
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

  // GET /api/analyze/:jobId/result — Retrieve completed analysis result
  router.get("/:jobId/result", (req: Request, res: Response) => {
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

    if (job.status !== "complete" || !job.result) {
      res.status(409).json({
        error: "not_ready",
        message: `Job is not complete (status: ${job.status})`,
      });
      return;
    }

    res.json(job.result);
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

    // Determine platform (web vs android) and detect framework
    const platform = detectPlatform(allPaths);

    let detectionResult: FrameworkDetectionResult;

    if (platform === "android") {
      // For Android projects, fetch Gradle build files to detect the navigation library
      const gradlePatterns = ["**/build.gradle", "**/build.gradle.kts"];
      const gradleEntries = filterFilesByPatterns(allFiles, gradlePatterns).filter(
        (f) => !isExcludedPath(f.path),
      );
      const gradleFiles = await fetchFileContents(
        owner,
        repo,
        gradleEntries,
        token,
        { ref: branch },
      );
      detectionResult = detectAndroidFramework(gradleFiles);
    } else if (platform === "flutter") {
      // For Flutter projects, fetch pubspec.yaml to detect the routing library
      const pubspecEntry = allFiles.find((f) => f.path === "pubspec.yaml");
      if (pubspecEntry) {
        const pubspecContents = await fetchFileContents(
          owner,
          repo,
          [pubspecEntry],
          token,
          { ref: branch },
        );
        if (pubspecContents[0]) {
          detectionResult = detectFlutterFramework(pubspecContents[0].content);
        } else {
          detectionResult = detectFlutterFramework("");
        }
      } else {
        detectionResult = detectFlutterFramework("");
      }
    } else if (platform === "ios") {
      // For iOS projects, fetch Swift/ObjC source files to detect SwiftUI vs UIKit
      const iosSourcePatterns = ["**/*.swift", "**/*.m", "**/*.h"];
      const iosEntries = filterFilesByPatterns(allFiles, iosSourcePatterns)
        .filter(
          (f) => !isExcludedPath(f.path),
        );

      // Prioritize files likely to contain UI imports so we don't miss
      // framework signals when slicing to 50 files.
      const uiNamePatterns = ["View", "ViewController", "App", "Scene", "Controller"];
      const prioritized = iosEntries.sort((a, b) => {
        const aHasUI = uiNamePatterns.some((p) => a.path.includes(p));
        const bHasUI = uiNamePatterns.some((p) => b.path.includes(p));
        if (aHasUI && !bHasUI) return -1;
        if (!aHasUI && bHasUI) return 1;
        return 0;
      });

      const iosSliced = prioritized.slice(0, 50);
      const iosFiles = await fetchFileContents(
        owner,
        repo,
        iosSliced,
        token,
        { ref: branch },
      );
      detectionResult = detectiOSFramework(iosFiles, allPaths);
    } else {
      // Web projects: find and parse package.json
      const pkgEntry = allFiles.find((f) => f.path === "package.json");

      let packageJson: PackageJson = {};
      if (pkgEntry) {
        const pkgContents = await fetchFileContents(
          owner,
          repo,
          [pkgEntry],
          token,
          {
            ref: branch,
          },
        );

        if (pkgContents[0]) {
          try {
            packageJson = JSON.parse(pkgContents[0].content) as PackageJson;
          } catch {
            jobManager.sendError(
              jobId,
              "package.json contains invalid JSON and could not be parsed",
            );
            return;
          }
        }
      }

      detectionResult = detectFramework(packageJson, allPaths);
    }

    const { framework, routingFilePatterns } = detectionResult;

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

    // Fetch component files — file extensions depend on the platform
    const isAndroidProject = isAndroidFramework(framework);
    const isIOSProject = isIOSFramework(framework);
    const isFlutterProject = isFlutterFramework(framework);

    let componentPatterns: string[];

    if (isFlutterProject) {
      componentPatterns = ["lib/**/*.dart"];
    } else if (isAndroidProject) {
      componentPatterns = ["**/*.kt", "**/*.java", "**/*.xml"];
    } else if (isIOSProject) {
      componentPatterns = ["**/*.swift", "**/*.m", "**/*.h", "**/*.storyboard"];
    } else {
      componentPatterns = [
        "**/*.tsx",
        "**/*.jsx",
        "**/*.ts",
        "**/*.js",
        "**/*.vue",
        "**/*.svelte",
        ...(framework === "plain-html" ? ["**/*.html"] : []),
      ];
    }
    const componentEntries = filterFilesByPatterns(
      allFiles,
      componentPatterns,
    ).filter((f) => {
      if (isExcludedPath(f.path)) return false;
      // For Flutter projects, exclude code-generated files (*.g.dart, *.freezed.dart)
      // but keep auto_route generated files (*.gr.dart)
      if (isFlutterProject) {
        const isAutoRouteGen = f.path.endsWith(".gr.dart");
        if (isAutoRouteGen) return true;
        if (FLUTTER_EXCLUDED_FILE_PATTERNS.some((re) => re.test(f.path))) return false;
      }
      return true;
    });
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
