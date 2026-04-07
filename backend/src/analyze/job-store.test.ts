import { describe, it, expect, beforeEach } from "vitest";
import { JobStore, getInMemoryJobKV, resetInMemoryJobKV } from "./job-store.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JobStore", () => {
  let store: JobStore;

  beforeEach(() => {
    resetInMemoryJobKV();
    store = new JobStore(getInMemoryJobKV());
  });

  describe("createJob", () => {
    it("creates a job and returns a unique ID", async () => {
      const id1 = await store.createJob("user1");
      const id2 = await store.createJob("user1");

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it("stores the job with correct initial state", async () => {
      const id = await store.createJob("user1");
      const job = await store.getJob(id!);

      expect(job).toBeDefined();
      expect(job!.userId).toBe("user1");
      expect(job!.status).toBe("pending");
      expect(job!.result).toBeUndefined();
      expect(job!.error).toBeUndefined();
    });

    it("returns null when per-user active job limit (5) is exceeded", async () => {
      const ids: (string | null)[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await store.createJob("user1"));
      }
      // 6th should be null
      const id6 = await store.createJob("user1");

      expect(ids.every((id) => id !== null)).toBe(true);
      expect(id6).toBeNull();

      // Other users are not affected
      const otherUserId = await store.createJob("user2");
      expect(otherUserId).toBeTruthy();
    });

    it("allows new jobs after existing ones complete", async () => {
      // Fill up with 5 jobs
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await store.createJob("user1");
        expect(id).not.toBeNull();
        ids.push(id!);
      }

      // Limit reached
      expect(await store.createJob("user1")).toBeNull();

      // Complete one job
      await store.sendComplete(ids[0], {
        framework: "test",
        screens: [],
        transitions: [],
      });

      // Now we can create another
      const newId = await store.createJob("user1");
      expect(newId).toBeTruthy();
    });
  });

  describe("getJob", () => {
    it("returns null for non-existent job", async () => {
      const job = await store.getJob("non-existent");
      expect(job).toBeNull();
    });

    it("returns the correct job", async () => {
      const id = await store.createJob("user1");
      const job = await store.getJob(id!);
      expect(job).toBeDefined();
      expect(job!.userId).toBe("user1");
    });
  });

  describe("sendProgress", () => {
    it("updates job status to running", async () => {
      const id = await store.createJob("user1");
      await store.sendProgress(id!, {
        step: "detecting_framework",
        message: "Detecting...",
      });

      const job = await store.getJob(id!);
      expect(job!.status).toBe("running");
      expect(job!.step).toBe("detecting_framework");
      expect(job!.message).toBe("Detecting...");
    });

    it("does not crash for non-existent job", async () => {
      await expect(
        store.sendProgress("non-existent", {
          step: "test",
          message: "test",
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("sendComplete", () => {
    it("marks job as complete and stores result", async () => {
      const id = await store.createJob("user1");
      const result = {
        framework: "next" as const,
        screens: [],
        transitions: [],
      };

      await store.sendComplete(id!, result);

      const job = await store.getJob(id!);
      expect(job!.status).toBe("complete");
      expect(job!.result).toEqual(result);
    });
  });

  describe("sendError", () => {
    it("marks job as errored and stores error message", async () => {
      const id = await store.createJob("user1");
      await store.sendError(id!, "Something went wrong");

      const job = await store.getJob(id!);
      expect(job!.status).toBe("error");
      expect(job!.error).toBe("Something went wrong");
    });
  });

  describe("access control", () => {
    it("stores the userId on the job", async () => {
      const id = await store.createJob("user1");
      const job = await store.getJob(id!);
      expect(job!.userId).toBe("user1");
    });

    it("different users get different jobs", async () => {
      const id1 = await store.createJob("user1");
      const id2 = await store.createJob("user2");

      const job1 = await store.getJob(id1!);
      const job2 = await store.getJob(id2!);

      expect(job1!.userId).toBe("user1");
      expect(job2!.userId).toBe("user2");
    });
  });
});
