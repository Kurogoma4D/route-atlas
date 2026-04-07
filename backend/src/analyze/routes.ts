/**
 * Analysis API Routes (Polling-based Progress)
 *
 * POST /api/analyze              — Enqueue an analysis job, returns { jobId }
 * GET  /api/analyze/:jobId        — Read job state from KV, return JSON
 * GET  /api/analyze/:jobId/result — Return result when complete
 *
 * The analysis pipeline runs either via a Cloudflare Queue consumer
 * or inline (for local dev without Queues).
 *
 * Reference: SPEC.md §6.1, §6.2, §6.3
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
import type { KVLike } from "../auth/session.js";
import type { PackageJson } from "../analysis/framework-detector.js";

// ---------------------------------------------------------------------------
// Queue message shape
// ---------------------------------------------------------------------------

export interface AnalyzeQueueMessage {
  jobId: string;
  userId: string;
  owner: string;
  repo: string;
  branch: string;
  model: SupportedModel;
  encryptedToken: string;
}

// ---------------------------------------------------------------------------
// Minimal Queue interface for type safety
// ---------------------------------------------------------------------------

export interface QueueLike {
  send(message: AnalyzeQueueMessage): Promise<void>;
}

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
  queue?: QueueLike;
  jobsKV?: KVLike;
}

/**
 * Resolve a JobStore for the current request.
 * Prefers the JOBS KV binding from the Workers env, then explicit deps,
 * and falls back to an in-memory store for local dev.
 */
function resolveJobStore(
  c: { env: unknown },
  deps: AnalyzeRouterDeps,
): JobStore {
  const envKV = (c.env as Record<string, unknown> | null)?.["JOBS"] as
    | KVLike
    | undefined;
  if (envKV) return new JobStore(envKV);
  if (deps.jobStore) return deps.jobStore;
  const kv = deps.jobsKV ?? getInMemoryJobKV();
  return new JobStore(kv);
}

export function createAnalyzeRouter(deps: AnalyzeRouterDeps): Hono {
  const router = new Hono();

  // POST /api/analyze — Start analysis job
  router.post("/", async (c) => {
    const jobStore = resolveJobStore(c, deps);
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

    // Try to enqueue via Cloudflare Queue binding; fall back to inline execution
    const queue: QueueLike | undefined =
      deps.queue ??
      ((c.env as Record<string, unknown>)?.["ANALYZE_QUEUE"] as
        | QueueLike
        | undefined);

    const message: AnalyzeQueueMessage = {
      jobId,
      userId,
      owner: body.owner,
      repo: body.repo,
      branch: body.branch,
      model,
      encryptedToken: session.encryptedToken!,
    };

    if (queue) {
      // Cloudflare Queue available — enqueue and return immediately
      try {
        await queue.send(message);
      } catch (err) {
        console.error(`[analyze] Failed to enqueue job ${jobId}:`, err);
        await jobStore
          .sendError(jobId, "Failed to enqueue analysis job")
          .catch(console.error);
        return c.json(
          {
            error: "queue_error",
            message: "Failed to enqueue analysis job. Please try again later.",
          },
          500,
        );
      }
    } else {
      // No queue binding (local dev) — run pipeline inline in background
      const env = c.env as Record<string, unknown> | undefined;
      runPipeline({
        ...message,
        jobStore,
        clientManager: deps.clientManager,
        sessionSecret: env?.["SESSION_SECRET"] as string | undefined,
      }).catch((err) => {
        console.error(
          `[analyze] Unhandled pipeline error for job ${jobId}:`,
          err,
        );
      });
    }

    // Return jobId immediately
    return c.json({ jobId }, 202);
  });

  // GET /api/analyze/:jobId/result — Retrieve completed analysis result
  router.get("/:jobId/result", async (c) => {
    const jobStore = resolveJobStore(c, deps);
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

  // GET /api/analyze/:jobId — Poll job state (JSON)
  router.get("/:jobId", async (c) => {
    const jobStore = resolveJobStore(c, deps);
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
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Queue consumer: processes analysis tasks from the queue
// ---------------------------------------------------------------------------

export async function handleAnalyzeQueue(
  message: AnalyzeQueueMessage,
  jobStore: JobStore,
  clientManager: CopilotClientManager,
  sessionSecret?: string,
): Promise<void> {
  try {
    await runPipeline({
      ...message,
      jobStore,
      clientManager,
      sessionSecret,
    });
  } catch (err) {
    console.error(`[queue] Pipeline failed for job ${message.jobId}:`, err);
    const errorMsg = err instanceof Error ? err.message : "Analysis failed";
    await jobStore.sendError(message.jobId, errorMsg).catch(console.error);
  }
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
  jobStore: JobStore;
  clientManager: CopilotClientManager;
  sessionSecret?: string;
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
    jobStore,
    clientManager,
    sessionSecret,
  } = params;

  try {
    const token = await decrypt(encryptedToken, sessionSecret);

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
      // For Android projects, fetch Gradle build files to detect the navigation library
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
      const iosEntries = filterFilesByPatterns(
        allFiles,
        iosSourcePatterns,
      ).filter((f) => !isExcludedPath(f.path));

      // Prioritize files likely to contain UI imports so we don't miss
      // framework signals when slicing to 50 files.
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

      const iosSliced = prioritized.slice(0, 50);
      const iosFiles = await fetchFileContents(owner, repo, iosSliced, token, {
        ref: branch,
      });
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
          {
            ref: branch,
          },
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
      { ref: branch },
    );

    // Step 3: Analyze routes (Turn 1)
    await jobStore.sendProgress(jobId, {
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
          // Fire-and-forget: KV write runs in background
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
