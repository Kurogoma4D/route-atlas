import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { vi } from "vitest";
import { AnalyzeService, SseEvent } from "./analyze.service";

describe("AnalyzeService", () => {
  let service: AnalyzeService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AnalyzeService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
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

  describe("connectToJob", () => {
    let mockEventSource: {
      addEventListener: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      onerror: ((ev: Event) => void) | null;
    };
    let listeners: Record<string, (event: MessageEvent) => void>;
    let originalEventSource: typeof EventSource;

    beforeEach(() => {
      originalEventSource = globalThis.EventSource;
      listeners = {};
      mockEventSource = {
        addEventListener: vi
          .fn()
          .mockImplementation(
            (type: string, handler: (event: MessageEvent) => void) => {
              listeners[type] = handler;
            },
          ),
        close: vi.fn(),
        onerror: null,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).EventSource = function () {
        return mockEventSource;
      };
    });

    afterEach(() => {
      globalThis.EventSource = originalEventSource;
      vi.restoreAllMocks();
    });

    it("should parse and emit progress events", () =>
      new Promise<void>((resolve) => {
        const events: SseEvent[] = [];
        service.connectToJob("job-1").subscribe({
          next: (event) => events.push(event),
          complete: () => {
            expect(events.length).toBe(2);
            expect(events[0].type).toBe("progress");
            if (events[0].type === "progress") {
              expect(events[0].data.step).toBe("fetching_files");
              expect(events[0].data.message).toBe("Fetching...");
            }
            resolve();
          },
        });

        listeners["progress"](
          new MessageEvent("progress", {
            data: JSON.stringify({
              step: "fetching_files",
              message: "Fetching...",
            }),
          }),
        );

        // Trigger complete to finish the observable
        listeners["complete"](
          new MessageEvent("complete", {
            data: JSON.stringify({ routes: [] }),
          }),
        );
      }));

    it("should close EventSource and complete observable on complete event", () =>
      new Promise<void>((resolve) => {
        service.connectToJob("job-2").subscribe({
          next: (event) => {
            expect(event.type).toBe("complete");
          },
          complete: () => {
            // close() is called in the finally block after subscriber.complete(),
            // so we verify it on the next microtask.
            queueMicrotask(() => {
              expect(mockEventSource.close).toHaveBeenCalled();
              resolve();
            });
          },
        });

        listeners["complete"](
          new MessageEvent("complete", {
            data: JSON.stringify({ result: "ok" }),
          }),
        );
      }));

    it("should close EventSource and complete observable on error event", () =>
      new Promise<void>((resolve) => {
        const events: SseEvent[] = [];
        service.connectToJob("job-3").subscribe({
          next: (event) => events.push(event),
          complete: () => {
            expect(mockEventSource.close).toHaveBeenCalled();
            expect(events.length).toBe(1);
            expect(events[0].type).toBe("error");
            if (events[0].type === "error") {
              expect(events[0].data.message).toBe("Something went wrong");
            }
            resolve();
          },
        });

        listeners["error"](
          new MessageEvent("error", {
            data: JSON.stringify({ message: "Something went wrong" }),
          }),
        );
      }));

    it("should close EventSource on unsubscribe", () => {
      const sub = service.connectToJob("job-4").subscribe();
      sub.unsubscribe();
      expect(mockEventSource.close).toHaveBeenCalled();
    });

    it("should handle native connection errors via onerror", () =>
      new Promise<void>((resolve) => {
        const events: SseEvent[] = [];
        service.connectToJob("job-5").subscribe({
          next: (event) => events.push(event),
          complete: () => {
            expect(mockEventSource.close).toHaveBeenCalled();
            expect(events.length).toBe(1);
            expect(events[0].type).toBe("error");
            if (events[0].type === "error") {
              expect(events[0].data.message).toBe(
                "Connection to analysis server lost",
              );
            }
            resolve();
          },
        });

        // Simulate native connection error
        mockEventSource.onerror!(new Event("error"));
      }));
  });
});
