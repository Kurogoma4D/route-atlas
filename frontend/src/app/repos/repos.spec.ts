import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { ReposComponent } from "./repos";
import type { ReposResponse, BranchesResponse } from "@route-atlas/shared";

const mockReposResponse: ReposResponse = {
  repos: [
    {
      id: 1,
      name: "angular-app",
      fullName: "user/angular-app",
      owner: "user",
      description: "An Angular application",
      private: false,
      defaultBranch: "main",
      language: "TypeScript",
      updatedAt: "2025-01-01T00:00:00Z",
      htmlUrl: "https://github.com/user/angular-app",
    },
    {
      id: 2,
      name: "secret-project",
      fullName: "user/secret-project",
      owner: "user",
      description: "A private project",
      private: true,
      defaultBranch: "main",
      language: "JavaScript",
      updatedAt: "2025-01-02T00:00:00Z",
      htmlUrl: "https://github.com/user/secret-project",
    },
    {
      id: 3,
      name: "react-site",
      fullName: "user/react-site",
      owner: "user",
      description: null,
      private: false,
      defaultBranch: "develop",
      language: "TypeScript",
      updatedAt: "2025-01-03T00:00:00Z",
      htmlUrl: "https://github.com/user/react-site",
    },
  ],
  page: 1,
  perPage: 30,
  hasNextPage: false,
};

const mockBranchesResponse: BranchesResponse = {
  branches: [
    { name: "main", commit: "abc123", protected: true },
    { name: "develop", commit: "def456", protected: false },
  ],
};

describe("ReposComponent", () => {
  let httpTesting: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReposComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideAnimationsAsync(),
      ],
    }).compileComponents();

    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  function createComponent() {
    const fixture = TestBed.createComponent(ReposComponent);
    fixture.detectChanges();
    return fixture;
  }

  function flushRepos(response: ReposResponse = mockReposResponse) {
    const req = httpTesting.expectOne("/api/repos?page=1&per_page=30");
    req.flush(response);
  }

  it("should create the component", () => {
    const fixture = createComponent();
    flushRepos();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it("should display the search field", async () => {
    const fixture = createComponent();
    flushRepos();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const searchInput = compiled.querySelector("input[matInput]");
    expect(searchInput).toBeTruthy();
  });

  it("should display repository list", async () => {
    const fixture = createComponent();
    flushRepos();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const repoNames = compiled.querySelectorAll(".repo-full-name");
    expect(repoNames.length).toBe(3);
    expect(repoNames[0].textContent).toContain("user/angular-app");
    expect(repoNames[1].textContent).toContain("user/secret-project");
  });

  it("should show private icon for private repos", async () => {
    const fixture = createComponent();
    flushRepos();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const privateIcons = compiled.querySelectorAll(".private-icon");
    expect(privateIcons.length).toBe(1);
  });

  it("should filter repos by search query", async () => {
    const fixture = createComponent();
    flushRepos();
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance.onSearchInput("angular");
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const repoNames = compiled.querySelectorAll(".repo-full-name");
    expect(repoNames.length).toBe(1);
    expect(repoNames[0].textContent).toContain("user/angular-app");
  });

  it("should show empty message when no repos match search", async () => {
    const fixture = createComponent();
    flushRepos();
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance.onSearchInput("nonexistent");
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const emptyMessage = compiled.querySelector(".empty-message");
    expect(emptyMessage).toBeTruthy();
    expect(emptyMessage?.textContent).toContain("見つかりません");
  });

  it("should load branches when a repo is selected", async () => {
    const fixture = createComponent();
    flushRepos();
    fixture.detectChanges();
    await fixture.whenStable();

    const repo = mockReposResponse.repos[0];
    fixture.componentInstance.selectRepo(repo);
    fixture.detectChanges();

    const branchReq = httpTesting.expectOne(
      "/api/repos/user/angular-app/branches",
    );
    branchReq.flush(mockBranchesResponse);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.branches().length).toBe(2);
    // Default branch should be auto-selected
    expect(fixture.componentInstance.selectedBranch()?.name).toBe("main");
  });

  it("should show the start analysis button when repo and branch are selected", async () => {
    const fixture = createComponent();
    flushRepos();
    fixture.detectChanges();
    await fixture.whenStable();

    const repo = mockReposResponse.repos[0];
    fixture.componentInstance.selectRepo(repo);
    fixture.detectChanges();

    const branchReq = httpTesting.expectOne(
      "/api/repos/user/angular-app/branches",
    );
    branchReq.flush(mockBranchesResponse);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const analyzeButton = compiled.querySelector(
      "button[mat-flat-button]:last-of-type",
    );
    expect(analyzeButton?.textContent).toContain("解析開始");
  });

  it("should show load more button when hasNextPage is true", async () => {
    const fixture = createComponent();
    flushRepos({
      ...mockReposResponse,
      hasNextPage: true,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const loadMoreButton = compiled.querySelector(".load-more button");
    expect(loadMoreButton).toBeTruthy();
    expect(loadMoreButton?.textContent).toContain("さらに読み込む");
  });

  it("should not show load more button when hasNextPage is false", async () => {
    const fixture = createComponent();
    flushRepos({
      ...mockReposResponse,
      hasNextPage: false,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const loadMoreButton = compiled.querySelector(".load-more button");
    expect(loadMoreButton).toBeFalsy();
  });

  it("should show error message when repos fail to load", async () => {
    const fixture = createComponent();

    const req = httpTesting.expectOne("/api/repos?page=1&per_page=30");
    req.flush(
      { error: "server_error" },
      { status: 500, statusText: "Internal Server Error" },
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const errorMessage = compiled.querySelector(".error-message");
    expect(errorMessage).toBeTruthy();
    expect(errorMessage?.textContent).toContain("失敗");
  });

  it("should show loading indicator initially", () => {
    const fixture = createComponent();
    const compiled = fixture.nativeElement as HTMLElement;

    const loadingBar = compiled.querySelector("mat-progress-bar");
    expect(loadingBar).toBeTruthy();

    flushRepos();
  });
});
