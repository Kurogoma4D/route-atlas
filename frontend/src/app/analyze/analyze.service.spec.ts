import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { AnalyzeService } from "./analyze.service";

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
});
