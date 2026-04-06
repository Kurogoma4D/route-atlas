/**
 * In-memory Job Manager for analysis jobs.
 *
 * Each analysis request creates a job identified by a UUID.
 * Jobs are scoped to the creating user and auto-cleaned after a timeout.
 *
 * Reference: SPEC.md §6.1, §6.3
 */

import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AnalysisResult } from "@route-atlas/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = "pending" | "running" | "complete" | "error";

export interface ProgressEvent {
  step: string;
  message: string;
}

export interface AnalysisJob {
  id: string;
  userId: string;
  status: JobStatus;
  result: AnalysisResult | null;
  error: string | null;
  sseConnections: Set<Response>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Job Manager
// ---------------------------------------------------------------------------

/** Default auto-cleanup timeout: 30 minutes. */
const DEFAULT_CLEANUP_TIMEOUT_MS = 30 * 60 * 1000;

/** Default maximum active (pending | running) jobs per user. */
const DEFAULT_MAX_JOBS_PER_USER = 5;

export class JobManager {
  private readonly jobs = new Map<string, AnalysisJob>();
  private readonly cleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly cleanupTimeoutMs: number;
  private readonly maxJobsPerUser: number;

  constructor(
    cleanupTimeoutMs: number = DEFAULT_CLEANUP_TIMEOUT_MS,
    maxJobsPerUser: number = DEFAULT_MAX_JOBS_PER_USER,
  ) {
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.maxJobsPerUser = maxJobsPerUser;
  }

  /**
   * Create a new analysis job for a user.
   * Returns the job ID, or `null` if the user has reached the active job limit.
   */
  createJob(userId: string): string | null {
    const activeCount = this.countActiveJobsForUser(userId);
    if (activeCount >= this.maxJobsPerUser) {
      return null;
    }

    const id = randomUUID();
    const job: AnalysisJob = {
      id,
      userId,
      status: "pending",
      result: null,
      error: null,
      sseConnections: new Set(),
      createdAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.scheduleCleanup(id);
    return id;
  }

  /**
   * Count active (pending or running) jobs for a given user.
   */
  countActiveJobsForUser(userId: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (
        job.userId === userId &&
        (job.status === "pending" || job.status === "running")
      ) {
        count++;
      }
    }
    return count;
  }

  /**
   * Retrieve a job by ID.
   * Returns undefined if the job does not exist.
   */
  getJob(jobId: string): AnalysisJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Add an SSE connection to a job.
   */
  addConnection(jobId: string, res: Response): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.sseConnections.add(res);
    }
  }

  /**
   * Remove an SSE connection from a job.
   */
  removeConnection(jobId: string, res: Response): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.sseConnections.delete(res);
    }
  }

  /**
   * Send a progress event to all SSE connections for a job.
   */
  sendProgress(jobId: string, event: ProgressEvent): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "running";
    const data = JSON.stringify(event);

    for (const res of job.sseConnections) {
      res.write(`event: progress\ndata: ${data}\n\n`);
    }
  }

  /**
   * Mark a job as complete and send the result to all SSE connections.
   */
  sendComplete(jobId: string, result: AnalysisResult): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "complete";
    job.result = result;
    const data = JSON.stringify(result);

    for (const res of job.sseConnections) {
      res.write(`event: complete\ndata: ${data}\n\n`);
      res.end();
    }
    job.sseConnections.clear();
  }

  /**
   * Mark a job as errored and send the error to all SSE connections.
   */
  sendError(jobId: string, message: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "error";
    job.error = message;
    const data = JSON.stringify({ message });

    for (const res of job.sseConnections) {
      res.write(`event: error\ndata: ${data}\n\n`);
      res.end();
    }
    job.sseConnections.clear();
  }

  /**
   * Remove a job and cancel its cleanup timer.
   */
  removeJob(jobId: string): void {
    const timer = this.cleanupTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(jobId);
    }
    const job = this.jobs.get(jobId);
    if (job) {
      // Close any remaining SSE connections
      for (const res of job.sseConnections) {
        res.end();
      }
      job.sseConnections.clear();
    }
    this.jobs.delete(jobId);
  }

  /** Return the number of active jobs. */
  get size(): number {
    return this.jobs.size;
  }

  /** Clear all jobs and timers. */
  clear(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    for (const job of this.jobs.values()) {
      for (const res of job.sseConnections) {
        res.end();
      }
      job.sseConnections.clear();
    }
    this.jobs.clear();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private scheduleCleanup(jobId: string): void {
    const timer = setTimeout(() => {
      this.removeJob(jobId);
    }, this.cleanupTimeoutMs);

    // Unref the timer so it doesn't prevent Node from exiting
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    this.cleanupTimers.set(jobId, timer);
  }
}
