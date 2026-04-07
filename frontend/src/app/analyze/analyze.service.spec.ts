import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { vi } from "vitest";
import { AnalyzeService, AnalysisEvent } from "./analyze.service";

describe("AnalyzeService", () => {
  let service: AnalyzeService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AnalyzeService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    httpTesting.verify();
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });

  describe("startAnalysis", () => {
    it("should POST to /api/analyze and return jobId", () => {
      const mockResponse = { jobId: "test-job-123" };

      service
        .startAnalysis({
          owner: "user",
          repo: "my-repo",
          branch: "main",
        })
        .subscribe((response) => {
          expect(response.jobId).toBe("test-job-123");
        });

      const req = httpTesting.expectOne("/api/analyze");
      expect(req.request.method).toBe("POST");
      expect(req.request.body).toEqual({
        owner: "user",
        repo: "my-repo",
        branch: "main",
      });
      expect(req.request.withCredentials).toBe(true);
      req.flush(mockResponse);
    });

    it("should include model when provided", () => {
      service
        .startAnalysis({
          owner: "user",
          repo: "my-repo",
          branch: "main",
          model: "gpt-4o",
        })
        .subscribe();

      const req = httpTesting.expectOne("/api/analyze");
      expect(req.request.body.model).toBe("gpt-4o");
      req.flush({ jobId: "test-job-456" });
    });
  });

  describe("pollJob", () => {
    it("should emit progress events while polling", () => {
      const events: AnalysisEvent[] = [];
      const sub = service.pollJob("job-1").subscribe({
        next: (event) => events.push(event),
      });

      // timer(0, ...) fires immediately with fakeTimers after advanceTimersByTime(0)
      vi.advanceTimersByTime(0);

      const req1 = httpTesting.expectOne("/api/analyze/job-1");
      req1.flush({
        status: "running",
        step: "fetching_files",
        message: "Fetching...",
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("progress");
      if (events[0].type === "progress") {
        expect(events[0].data.step).toBe("fetching_files");
        expect(events[0].data.message).toBe("Fetching...");
      }

      sub.unsubscribe();
    });

    it("should fetch result and emit complete when status is complete", () => {
      const events: AnalysisEvent[] = [];
      service.pollJob("job-2").subscribe({
        next: (event) => events.push(event),
      });

      vi.advanceTimersByTime(0);

      // First poll returns complete
      const pollReq = httpTesting.expectOne("/api/analyze/job-2");
      pollReq.flush({
        status: "complete",
        step: "complete",
        message: "Done",
      });

      // Service should then fetch the result
      const resultReq = httpTesting.expectOne("/api/analyze/job-2/result");
      resultReq.flush({ routes: [] });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("complete");
      expect(events[0].data).toEqual({ routes: [] });
    });

    it("should emit error when job status is error", () => {
      const events: AnalysisEvent[] = [];
      service.pollJob("job-3").subscribe({
        next: (event) => events.push(event),
      });

      vi.advanceTimersByTime(0);

      const req = httpTesting.expectOne("/api/analyze/job-3");
      req.flush({
        status: "error",
        step: "error",
        message: "Something went wrong",
        error: "Something went wrong",
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("error");
      if (events[0].type === "error") {
        expect(events[0].data.message).toBe("Something went wrong");
      }
    });

    it("should stop polling on unsubscribe", () => {
      const sub = service.pollJob("job-4").subscribe();

      vi.advanceTimersByTime(0);

      // First poll
      const req = httpTesting.expectOne("/api/analyze/job-4");
      req.flush({
        status: "running",
        step: "detecting_framework",
        message: "Detecting...",
      });

      sub.unsubscribe();

      // Advance timer — no more requests should be made
      vi.advanceTimersByTime(3000);
      httpTesting.expectNone("/api/analyze/job-4");
    });

    it("should emit error on network failure", () => {
      const events: AnalysisEvent[] = [];
      service.pollJob("job-5").subscribe({
        next: (event) => events.push(event),
      });

      vi.advanceTimersByTime(0);

      const req = httpTesting.expectOne("/api/analyze/job-5");
      req.error(new ProgressEvent("error"));

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("error");
      if (events[0].type === "error") {
        expect(events[0].data.message).toBe(
          "Connection to analysis server lost",
        );
      }
    });

    it("should poll multiple times until complete", () => {
      const events: AnalysisEvent[] = [];
      service.pollJob("job-6").subscribe({
        next: (event) => events.push(event),
      });

      vi.advanceTimersByTime(0);

      // First poll — running
      const req1 = httpTesting.expectOne("/api/analyze/job-6");
      req1.flush({
        status: "running",
        step: "detecting_framework",
        message: "Detecting...",
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("progress");

      // Advance timer to trigger second poll
      vi.advanceTimersByTime(2500);

      const req2 = httpTesting.expectOne("/api/analyze/job-6");
      req2.flush({
        status: "complete",
        step: "complete",
        message: "Done",
      });

      // Fetch result
      const resultReq = httpTesting.expectOne("/api/analyze/job-6/result");
      resultReq.flush({ screens: [], transitions: [] });

      expect(events.length).toBe(2);
      expect(events[1].type).toBe("complete");

      // No more polls after completion
      vi.advanceTimersByTime(2500);
      httpTesting.expectNone("/api/analyze/job-6");
    });
  });

  describe("connectToJob (deprecated)", () => {
    it("should delegate to pollJob", () => {
      const events: AnalysisEvent[] = [];
      const sub = service.connectToJob("job-compat").subscribe({
        next: (event) => events.push(event),
      });

      vi.advanceTimersByTime(0);

      const req = httpTesting.expectOne("/api/analyze/job-compat");
      req.flush({
        status: "running",
        step: "analyzing_routes",
        message: "Analyzing...",
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("progress");

      sub.unsubscribe();
    });
  });
});
