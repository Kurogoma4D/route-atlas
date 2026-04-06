import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { ReposService } from "./repos.service";

describe("ReposService", () => {
  let service: ReposService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ReposService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });

  describe("getRepos", () => {
    it("should fetch repos with default pagination", () => {
      const mockResponse = {
        repos: [
          {
            id: 1,
            name: "test-repo",
            fullName: "user/test-repo",
            owner: "user",
            description: "A test repo",
            private: false,
            defaultBranch: "main",
            language: "TypeScript",
            updatedAt: "2025-01-01T00:00:00Z",
            htmlUrl: "https://github.com/user/test-repo",
          },
        ],
        page: 1,
        perPage: 30,
        hasNextPage: false,
      };

      service.getRepos().subscribe((response) => {
        expect(response.repos).toHaveLength(1);
        expect(response.repos[0].name).toBe("test-repo");
        expect(response.hasNextPage).toBe(false);
      });

      const req = httpTesting.expectOne("/api/repos?page=1&per_page=30");
      expect(req.request.method).toBe("GET");
      expect(req.request.withCredentials).toBe(true);
      req.flush(mockResponse);
    });

    it("should fetch repos with custom pagination", () => {
      const mockResponse = {
        repos: [],
        page: 2,
        perPage: 10,
        hasNextPage: true,
      };

      service.getRepos(2, 10).subscribe((response) => {
        expect(response.page).toBe(2);
        expect(response.perPage).toBe(10);
        expect(response.hasNextPage).toBe(true);
      });

      const req = httpTesting.expectOne("/api/repos?page=2&per_page=10");
      expect(req.request.method).toBe("GET");
      req.flush(mockResponse);
    });
  });

  describe("getBranches", () => {
    it("should fetch branches for a repository", () => {
      const mockResponse = {
        branches: [
          { name: "main", commit: "abc123", protected: true },
          { name: "develop", commit: "def456", protected: false },
        ],
      };

      service.getBranches("user", "test-repo").subscribe((response) => {
        expect(response.branches).toHaveLength(2);
        expect(response.branches[0].name).toBe("main");
      });

      const req = httpTesting.expectOne("/api/repos/user/test-repo/branches");
      expect(req.request.method).toBe("GET");
      expect(req.request.withCredentials).toBe(true);
      req.flush(mockResponse);
    });
  });
});
