import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { GraphService } from "./graph.service";
import type { AnalysisResult } from "@route-atlas/shared";

describe("GraphService", () => {
  let service: GraphService;
  let httpTesting: HttpTestingController;

  const mockResult: AnalysisResult = {
    framework: "next",
    screens: [
      {
        id: "screen_home",
        path: "/",
        componentFile: "app/page.tsx",
        label: "Home",
        description: "Home page",
        variants: [],
      },
    ],
    transitions: [],
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(GraphService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });

  describe("fetchResult", () => {
    it("should GET /api/analyze/:jobId/result", () => {
      service.fetchResult("job-123").subscribe((result) => {
        expect(result.framework).toBe("next");
        expect(result.screens.length).toBe(1);
      });

      const req = httpTesting.expectOne("/api/analyze/job-123/result");
      expect(req.request.method).toBe("GET");
      expect(req.request.withCredentials).toBe(true);
      req.flush(mockResult);
    });

    it("should encode jobId in the URL", () => {
      service.fetchResult("job with spaces").subscribe();

      const req = httpTesting.expectOne(
        "/api/analyze/job%20with%20spaces/result",
      );
      expect(req.request.method).toBe("GET");
      req.flush(mockResult);
    });
  });

  describe("fetchGraphElements", () => {
    it("should return both result and converted elements", () => {
      service
        .fetchGraphElements("job-123")
        .subscribe(({ result, elements }) => {
          expect(result.framework).toBe("next");
          // Should have at least the screen node
          const screenNodes = elements.filter(
            (e) => e.data["id"] === "screen_home",
          );
          expect(screenNodes.length).toBe(1);
        });

      const req = httpTesting.expectOne("/api/analyze/job-123/result");
      req.flush(mockResult);
    });
  });
});
