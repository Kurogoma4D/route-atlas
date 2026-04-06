import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JobManager } from "./job-manager.js";
import type { Response } from "express";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock Response for SSE testing. */
function createMockResponse(): Response & {
  written: string[];
  ended: boolean;
} {
  const written: string[] = [];
  let ended = false;

  return {
    written,
    ended,
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      ended = true;
    }),
  } as unknown as Response & { written: string[]; ended: boolean };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JobManager", () => {
  let manager: JobManager;

  beforeEach(() => {
    vi.useFakeTimers();
    // Use a short cleanup timeout for testing
    manager = new JobManager(5000);
  });

  afterEach(() => {
    manager.clear();
    vi.useRealTimers();
  });

  describe("createJob", () => {
    it("creates a job and returns a unique ID", () => {
      const id1 = manager.createJob("user1");
      const id2 = manager.createJob("user1");

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it("stores the job with correct initial state", () => {
      const id = manager.createJob("user1");
      const job = manager.getJob(id!);

      expect(job).toBeDefined();
      expect(job!.userId).toBe("user1");
      expect(job!.status).toBe("pending");
      expect(job!.result).toBeNull();
      expect(job!.error).toBeNull();
      expect(job!.sseConnections.size).toBe(0);
    });

    it("increments the size count", () => {
      expect(manager.size).toBe(0);
      manager.createJob("user1");
      expect(manager.size).toBe(1);
      manager.createJob("user2");
      expect(manager.size).toBe(2);
    });

    it("returns null when per-user active job limit is exceeded", () => {
      // Create a manager with a low limit
      const limitedManager = new JobManager(5000, 2);

      const id1 = limitedManager.createJob("user1");
      const id2 = limitedManager.createJob("user1");
      const id3 = limitedManager.createJob("user1");

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id3).toBeNull();

      // Other users are not affected
      const id4 = limitedManager.createJob("user2");
      expect(id4).toBeTruthy();

      limitedManager.clear();
    });

    it("allows new jobs after existing ones complete", () => {
      const limitedManager = new JobManager(5000, 1);

      const id1 = limitedManager.createJob("user1");
      expect(id1).toBeTruthy();

      // Limit reached
      expect(limitedManager.createJob("user1")).toBeNull();

      // Complete the first job
      limitedManager.sendComplete(id1!, {
        framework: "test",
        screens: [],
        transitions: [],
      });

      // Now we can create another
      const id2 = limitedManager.createJob("user1");
      expect(id2).toBeTruthy();

      limitedManager.clear();
    });
  });

  describe("getJob", () => {
    it("returns undefined for non-existent job", () => {
      expect(manager.getJob("non-existent")).toBeUndefined();
    });

    it("returns the correct job", () => {
      const id = manager.createJob("user1");
      const job = manager.getJob(id);
      expect(job!.id).toBe(id);
    });
  });

  describe("access control", () => {
    it("stores the userId on the job", () => {
      const id = manager.createJob("user1");
      const job = manager.getJob(id);
      expect(job!.userId).toBe("user1");
    });

    it("different users get different jobs", () => {
      const id1 = manager.createJob("user1");
      const id2 = manager.createJob("user2");

      expect(manager.getJob(id1)!.userId).toBe("user1");
      expect(manager.getJob(id2)!.userId).toBe("user2");
    });
  });

  describe("SSE connections", () => {
    it("adds and removes connections", () => {
      const id = manager.createJob("user1");
      const res = createMockResponse();

      manager.addConnection(id, res);
      expect(manager.getJob(id)!.sseConnections.size).toBe(1);

      manager.removeConnection(id, res);
      expect(manager.getJob(id)!.sseConnections.size).toBe(0);
    });

    it("does not crash when adding to non-existent job", () => {
      const res = createMockResponse();
      expect(() => manager.addConnection("nope", res)).not.toThrow();
    });
  });

  describe("sendProgress", () => {
    it("sends progress events to all SSE connections", () => {
      const id = manager.createJob("user1");
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      manager.addConnection(id, res1);
      manager.addConnection(id, res2);

      manager.sendProgress(id, {
        step: "detecting_framework",
        message: "Detecting...",
      });

      expect(res1.write).toHaveBeenCalledWith(
        'event: progress\ndata: {"step":"detecting_framework","message":"Detecting..."}\n\n',
      );
      expect(res2.write).toHaveBeenCalledWith(
        'event: progress\ndata: {"step":"detecting_framework","message":"Detecting..."}\n\n',
      );
    });

    it("updates job status to running", () => {
      const id = manager.createJob("user1");
      manager.sendProgress(id, { step: "test", message: "test" });
      expect(manager.getJob(id)!.status).toBe("running");
    });
  });

  describe("sendComplete", () => {
    it("sends complete event and closes connections", () => {
      const id = manager.createJob("user1");
      const res = createMockResponse();
      manager.addConnection(id, res);

      const result = {
        framework: "next",
        screens: [],
        transitions: [],
      };

      manager.sendComplete(id, result);

      expect(res.write).toHaveBeenCalledWith(
        expect.stringContaining("event: complete"),
      );
      expect(res.end).toHaveBeenCalled();
      expect(manager.getJob(id)!.status).toBe("complete");
      expect(manager.getJob(id)!.result).toEqual(result);
      expect(manager.getJob(id)!.sseConnections.size).toBe(0);
    });
  });

  describe("sendError", () => {
    it("sends error event and closes connections", () => {
      const id = manager.createJob("user1");
      const res = createMockResponse();
      manager.addConnection(id, res);

      manager.sendError(id, "Something went wrong");

      expect(res.write).toHaveBeenCalledWith(
        'event: error\ndata: {"message":"Something went wrong"}\n\n',
      );
      expect(res.end).toHaveBeenCalled();
      expect(manager.getJob(id)!.status).toBe("error");
      expect(manager.getJob(id)!.error).toBe("Something went wrong");
      expect(manager.getJob(id)!.sseConnections.size).toBe(0);
    });
  });

  describe("auto-cleanup", () => {
    it("removes job after timeout", () => {
      const id = manager.createJob("user1");
      expect(manager.getJob(id)).toBeDefined();

      vi.advanceTimersByTime(5001);

      expect(manager.getJob(id)).toBeUndefined();
      expect(manager.size).toBe(0);
    });

    it("does not remove job before timeout", () => {
      const id = manager.createJob("user1");

      vi.advanceTimersByTime(4999);

      expect(manager.getJob(id)).toBeDefined();
    });
  });

  describe("removeJob", () => {
    it("removes a job and cancels its cleanup timer", () => {
      const id = manager.createJob("user1");
      manager.removeJob(id);

      expect(manager.getJob(id)).toBeUndefined();
      expect(manager.size).toBe(0);
    });

    it("closes SSE connections on removal", () => {
      const id = manager.createJob("user1");
      const res = createMockResponse();
      manager.addConnection(id, res);

      manager.removeJob(id);

      expect(res.end).toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("removes all jobs", () => {
      manager.createJob("user1");
      manager.createJob("user2");
      expect(manager.size).toBe(2);

      manager.clear();
      expect(manager.size).toBe(0);
    });
  });
});
