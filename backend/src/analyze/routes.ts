/**
 * Analysis API Routes (Polling-based Progress)
 *
 * POST /api/analyze              -- Start an analysis job, returns { jobId }
 * GET  /api/analyze/:jobId        -- Read job state, return JSON
 * GET  /api/analyze/:jobId/result -- Return result when complete
 *
 * The analysis pipeline runs in-process on Cloud Run (no queue needed;
 * Cloud Run supports up to 60-minute request timeouts).
 *
 * Reference: SPEC.md S6.1, S6.2, S6.3
 */

import { Hono } from "hono";
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
  isReactNativeFramework,
  isAstroFramework,
  isExcludedPath,
} from "../analysis/framework-detector.js";
import type { FrameworkDetectionResult } from "../analysis/framework-detector.js";
import {
  FLUTTER_EXCLUDED_FILE_PATTERNS,
  REACT_NATIVE_EXCLUDED_DIR_PREFIXES,
} from "../analysis/constants.js";
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
import { JobStore, getInMemoryJobKV } from "./job-store.js";
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
  jobStore?: JobStore;
}

/**
 * Resolve a JobStore for the current request.
 * Uses the explicitly provided store or falls back to an in-memory store.
 */
function resolveJobStore(deps: AnalyzeRouterDeps): JobStore {
  if (deps.jobStore) return deps.jobStore;
  return new JobStore(getInMemoryJobKV());
}

export function createAnalyzeRouter(deps: AnalyzeRouterDeps): Hono {
  const router = new Hono();

  // POST /api/analyze -- Start analysis job
  router.post("/", async (c) => {
    const jobStore = resolveJobStore(deps);
    let body: AnalyzeRequestBody;
    try {
      body = (await c.req.json()) as AnalyzeRequestBody;
    } catch {
      return c.json(
        {
          error: "invalid_json",
          message: "Request body must be valid JSON",
        },
        400,
      );
    }

    // Validate required fields
    if (!body.owner || !body.repo || !body.branch) {
      return c.json(
        {
          error: "validation_error",
          message: "owner, repo, and branch are required",
        },
        400,
      );
    }

    // Validate model if provided
    const model: SupportedModel =
      body.model && isSupportedModel(body.model)
        ? (body.model as SupportedModel)
        : DEFAULT_MODEL;

    const session = c.get("session");
    const userId = session.user!.login;
    const jobId = await jobStore.createJob(userId);

    if (jobId === null) {
      return c.json(
        {
          error: "too_many_jobs",
          message:
            "Too many active analysis jobs. Please wait for existing jobs to complete.",
        },
        429,
      );
    }

    const encryptedToken = session.encryptedToken!;

    // Run pipeline in-process (fire-and-forget for the HTTP response)
    runPipeline({
      jobId,
      userId,
      owner: body.owner,
      repo: body.repo,
      branch: body.branch,
      model,
      encryptedToken,
      jobStore,
      clientManager: deps.clientManager,
    }).catch((err) => {
      console.error(
        `[analyze] Unhandled pipeline error for job ${jobId}:`,
        err,
      );
    });

    // Return jobId immediately
    return c.json({ jobId }, 202);
  });

  // GET /api/analyze/:jobId/result -- Retrieve completed analysis result
  router.get("/:jobId/result", async (c) => {
    const jobStore = resolveJobStore(deps);
    const jobId = c.req.param("jobId");
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return c.json(
        {
          error: "not_found",
          message: "Job not found",
        },
        404,
      );
    }

    // Verify ownership
    const session = c.get("session");
    const userId = session.user!.login;
    if (job.userId !== userId) {
      return c.json(
        {
          error: "forbidden",
          message: "Access denied",
        },
        403,
      );
    }

    if (job.status !== "complete" || !job.result) {
      return c.json(
        {
          error: "not_ready",
          message: `Job is not complete (status: ${job.status})`,
        },
        409,
      );
    }

    return c.json(job.result);
  });

  // GET /api/analyze/:jobId -- Poll job state (JSON)
  router.get("/:jobId", async (c) => {
    const jobStore = resolveJobStore(deps);
    const jobId = c.req.param("jobId");
    const job = await jobStore.getJob(jobId);

    if (!job) {
      return c.json(
        {
          error: "not_found",
          message: "Job not found",
        },
        404,
      );
    }

    // Verify ownership
    const session = c.get("session");
    const userId = session.user!.login;
    if (job.userId !== userId) {
      return c.json(
        {
          error: "forbidden",
          message: "Access denied",
        },
        403,
      );
    }

    // Return job state without the full result to keep polling responses small.
    // The result is available via GET /:jobId/result when status is "complete".
    return c.json({
      status: job.status,
      step: job.step,
      message: job.message,
      ...(job.error ? { error: job.error } : {}),
      ...(job.metadata ? { metadata: job.metadata } : {}),
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Background pipeline runner (in-process, no subrequest budget)
// ---------------------------------------------------------------------------

interface PipelineParams {
  jobId: string;
  userId: string;
  owner: string;
  repo: string;
  branch: string;
  model: SupportedModel;
  encryptedToken: string;
  jobStore: JobStore;
  clientManager: CopilotClientManager;
}

async function runPipeline(params: PipelineParams): Promise<void> {
  const {
    jobId,
    owner,
    repo,
    branch,
    model,
    encryptedToken,
    jobStore,
    clientManager,
  } = params;

  try {
    const token = await decrypt(encryptedToken);

    // Step 1: Detect framework
    await jobStore.sendProgress(jobId, {
      step: "detecting_framework",
      message: "フレームワークを検出中...",
    });

    const { files: allFiles } = await fetchFileTree(owner, repo, branch, token);
    const allPaths = allFiles.map((f) => f.path);

    // Determine platform (web vs android) and detect framework
    const platform = detectPlatform(allPaths);

    let detectionResult: FrameworkDetectionResult;

    if (platform === "android") {
      const gradlePatterns = ["**/build.gradle", "**/build.gradle.kts"];
      const gradleEntries = filterFilesByPatterns(
        allFiles,
        gradlePatterns,
      ).filter((f) => !isExcludedPath(f.path));
      const gradleFiles = await fetchFileContents(
        owner,
        repo,
        gradleEntries,
        token,
        { maxFiles: 50 },
      );
      detectionResult = detectAndroidFramework(gradleFiles);
    } else if (platform === "flutter") {
      const pubspecEntry = allFiles.find((f) => f.path === "pubspec.yaml");
      if (pubspecEntry) {
        const pubspecContents = await fetchFileContents(
          owner,
          repo,
          [pubspecEntry],
          token,
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
      const iosSourcePatterns = ["**/*.swift", "**/*.m", "**/*.h"];
      const iosEntries = filterFilesByPatterns(
        allFiles,
        iosSourcePatterns,
      ).filter((f) => !isExcludedPath(f.path));

      const uiNamePatterns = [
        "View",
        "ViewController",
        "App",
        "Scene",
        "Controller",
      ];
      const prioritized = iosEntries.sort((a, b) => {
        const aHasUI = uiNamePatterns.some((p) => a.path.includes(p));
        const bHasUI = uiNamePatterns.some((p) => b.path.includes(p));
        if (aHasUI && !bHasUI) return -1;
        if (!aHasUI && bHasUI) return 1;
        return 0;
      });

      const iosFiles = await fetchFileContents(
        owner,
        repo,
        prioritized,
        token,
        { maxFiles: 10 },
      );
      detectionResult = detectiOSFramework(iosFiles, allPaths);
    } else {
      // Web projects (and React Native): find and parse package.json.
      const pkgEntry = allFiles.find((f) => f.path === "package.json");

      let packageJson: PackageJson = {};
      if (pkgEntry) {
        const pkgContents = await fetchFileContents(
          owner,
          repo,
          [pkgEntry],
          token,
        );

        if (pkgContents[0]) {
          try {
            packageJson = JSON.parse(pkgContents[0].content) as PackageJson;
          } catch {
            await jobStore.sendError(
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

    // Send detected framework metadata
    await jobStore.sendProgress(jobId, {
      step: "detecting_framework",
      message: "フレームワークを検出しました",
      metadata: {
        framework,
        platform,
        totalFiles: allFiles.length,
      },
    });

    // Step 2: Fetch files
    await jobStore.sendProgress(jobId, {
      step: "fetching_files",
      message: "ファイルを取得中...",
    });

    const routingEntries = filterFilesByPatterns(allFiles, routingFilePatterns);
    const routingFiles = await fetchFileContents(
      owner,
      repo,
      routingEntries,
      token,
      { maxFiles: 50 },
    );

    // Fetch component files -- file extensions depend on the platform
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
        ...(isAstroFramework(framework)
          ? ["**/*.astro", "**/*.md", "**/*.mdx"]
          : []),
      ];
    }
    const isReactNativeProject = isReactNativeFramework(framework);
    const componentEntries = filterFilesByPatterns(
      allFiles,
      componentPatterns,
    ).filter((f) => {
      if (isExcludedPath(f.path)) return false;
      if (isReactNativeProject) {
        if (
          REACT_NATIVE_EXCLUDED_DIR_PREFIXES.some((p) => f.path.startsWith(p))
        )
          return false;
      }
      if (isFlutterProject) {
        if (framework === "flutter-auto-route" && f.path.endsWith(".gr.dart"))
          return true;
        if (FLUTTER_EXCLUDED_FILE_PATTERNS.some((re) => re.test(f.path)))
          return false;
      }
      return true;
    });

    const componentFiles = await fetchFileContents(
      owner,
      repo,
      componentEntries,
      token,
      { maxFiles: 50 },
    );

    // Send file count metadata
    await jobStore.sendProgress(jobId, {
      step: "fetching_files",
      message: "ファイルを取得しました",
      metadata: {
        routingFileCount: routingFiles.length,
        componentFileCount: componentFiles.length,
      },
    });

    // Step 3: Analyze routes (Turn 1)
    await jobStore.sendProgress(jobId, {
      step: "analyzing_routes",
      message: "ルートを解析中...",
    });

    const adapter = clientManager.getClient(params.userId, token);
    const pipeline = new AnalysisPipeline(adapter);

    // Restrict the file tree passed to Copilot tools to files the analysis
    // actually cares about. Passing the entire tree (node_modules, images,
    // build output, etc.) would make tool responses noisy and wasteful.
    const relevantTreeEntries = allFiles.filter((entry) => {
      if (isExcludedPath(entry.path)) return false;
      return (
        routingEntries.some((r) => r.path === entry.path) ||
        componentEntries.some((c) => c.path === entry.path)
      );
    });

    const result = await pipeline.run({
      framework,
      routingFiles,
      componentFiles,
      model,
      fileToolContext: {
        owner,
        repo,
        branch,
        token,
        fileTree: relevantTreeEntries,
      },
      onProgress: (stage) => {
        if (stage === "analyzing_variants") {
          void jobStore.sendProgress(jobId, {
            step: "analyzing_variants",
            message: "バリエーションを解析中...",
          });
        } else if (stage === "analyzing_transitions") {
          void jobStore.sendProgress(jobId, {
            step: "analyzing_transitions",
            message: "画面遷移を解析中...",
          });
        }
      },
    });

    // Mark complete
    await jobStore.sendComplete(jobId, result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Analysis failed unexpectedly";
    await jobStore.sendError(jobId, message);
  }
}
