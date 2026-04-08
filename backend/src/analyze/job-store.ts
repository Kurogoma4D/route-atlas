/**
 * KV-based Job Store for analysis jobs.
 *
 * Replaces the in-memory JobManager with a stateless KV store
 * compatible with Cloudflare Workers. Each job state is stored
 * as a JSON value under `job:{jobId}` with a 1-hour TTL.
 *
 * For local development / tests an in-memory KV fallback is provided.
 *
 * Reference: SPEC.md §6.1, §6.3
 */

import type { AnalysisResult } from "@route-atlas/shared";
import type { KVLike } from "../auth/session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = "pending" | "running" | "complete" | "error";

export interface JobState {
  status: JobStatus;
  step: string;
  message: string;
  userId: string;
  result?: AnalysisResult;
  error?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Jobs expire from KV after 1 hour. */
const JOB_TTL_SECONDS = 60 * 60;

/** Maximum active (pending | running) jobs per user. */
const MAX_ACTIVE_JOBS_PER_USER = 5;

/** KV key prefix for job state. */
const JOB_KEY_PREFIX = "job:";

/** KV key prefix for per-user active job tracking. */
const USER_JOBS_KEY_PREFIX = "user_jobs:";

// ---------------------------------------------------------------------------
// Job Store
// ---------------------------------------------------------------------------

export class JobStore {
  constructor(private readonly kv: KVLike) {}

  /**
   * Create a new analysis job.
   * Returns the job ID, or `null` if the user already has too many active jobs.
   */
  async createJob(userId: string): Promise<string | null> {
    const activeCount = await this.countActiveJobsForUser(userId);
    if (activeCount >= MAX_ACTIVE_JOBS_PER_USER) {
      return null;
    }

    const jobId = crypto.randomUUID();
    const state: JobState = {
      status: "pending",
      step: "",
      message: "ジョブを開始しています...",
      userId,
      createdAt: Date.now(),
    };

    await this.kv.put(`${JOB_KEY_PREFIX}${jobId}`, JSON.stringify(state), {
      expirationTtl: JOB_TTL_SECONDS,
    });

    // Track active jobs for rate limiting
    await this.addActiveJob(userId, jobId);

    return jobId;
  }

  /**
   * Get the current state of a job.
   */
  async getJob(jobId: string): Promise<JobState | null> {
    const raw = await this.kv.get(`${JOB_KEY_PREFIX}${jobId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as JobState;
    } catch {
      return null;
    }
  }

  /**
   * Update job progress (sets status to "running").
   */
  async sendProgress(
    jobId: string,
    event: { step: string; message: string },
  ): Promise<void> {
    const state = await this.getJob(jobId);
    if (!state) {
      console.warn(`[JobStore] sendProgress: job ${jobId} not found in KV`);
      return;
    }

    state.status = "running";
    state.step = event.step;
    state.message = event.message;

    await this.kv.put(`${JOB_KEY_PREFIX}${jobId}`, JSON.stringify(state), {
      expirationTtl: JOB_TTL_SECONDS,
    });
    console.log(`[JobStore] sendProgress: ${jobId} → ${event.step}`);
  }

  /**
   * Mark a job as complete with a result.
   */
  async sendComplete(jobId: string, result: AnalysisResult): Promise<void> {
    const state = await this.getJob(jobId);
    if (!state) {
      console.warn(`[JobStore] sendComplete: job ${jobId} not found in KV`);
      return;
    }

    state.status = "complete";
    state.step = "complete";
    state.message = "分析が完了しました";
    state.result = result;

    await this.kv.put(`${JOB_KEY_PREFIX}${jobId}`, JSON.stringify(state), {
      expirationTtl: JOB_TTL_SECONDS,
    });

    console.log(`[JobStore] sendComplete: ${jobId}`);
    // Remove from active jobs
    await this.removeActiveJob(state.userId, jobId);
  }

  /**
   * Mark a job as errored.
   */
  async sendError(jobId: string, message: string): Promise<void> {
    const state = await this.getJob(jobId);
    if (!state) {
      console.warn(`[JobStore] sendError: job ${jobId} not found in KV`);
      return;
    }

    state.status = "error";
    state.step = "error";
    state.message = message;
    state.error = message;

    await this.kv.put(`${JOB_KEY_PREFIX}${jobId}`, JSON.stringify(state), {
      expirationTtl: JOB_TTL_SECONDS,
    });

    console.log(`[JobStore] sendError: ${jobId} → ${message}`);
    // Remove from active jobs
    await this.removeActiveJob(state.userId, jobId);
  }

  // -------------------------------------------------------------------------
  // Active job tracking (per-user rate limiting)
  // -------------------------------------------------------------------------

  private async countActiveJobsForUser(userId: string): Promise<number> {
    const jobs = await this.getActiveJobs(userId);
    return jobs.length;
  }

  private async getActiveJobs(userId: string): Promise<string[]> {
    const raw = await this.kv.get(`${USER_JOBS_KEY_PREFIX}${userId}`);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  private async addActiveJob(userId: string, jobId: string): Promise<void> {
    const jobs = await this.getActiveJobs(userId);
    jobs.push(jobId);
    await this.kv.put(
      `${USER_JOBS_KEY_PREFIX}${userId}`,
      JSON.stringify(jobs),
      { expirationTtl: JOB_TTL_SECONDS },
    );
  }

  private async removeActiveJob(userId: string, jobId: string): Promise<void> {
    const jobs = await this.getActiveJobs(userId);
    const updated = jobs.filter((id) => id !== jobId);
    if (updated.length === 0) {
      await this.kv.delete(`${USER_JOBS_KEY_PREFIX}${userId}`);
    } else {
      await this.kv.put(
        `${USER_JOBS_KEY_PREFIX}${userId}`,
        JSON.stringify(updated),
        { expirationTtl: JOB_TTL_SECONDS },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory KV fallback for local development / tests
// ---------------------------------------------------------------------------

let _inMemoryJobStore: Map<
  string,
  { value: string; expiresAt: number }
> | null = null;

export function getInMemoryJobKV(): KVLike {
  if (!_inMemoryJobStore) {
    _inMemoryJobStore = new Map();
  }
  const store = _inMemoryJobStore;

  return {
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) {
      const ttl = options?.expirationTtl ?? JOB_TTL_SECONDS;
      store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

/**
 * Reset the in-memory job KV store. Useful for tests.
 */
export function resetInMemoryJobKV(): void {
  _inMemoryJobStore = null;
}
