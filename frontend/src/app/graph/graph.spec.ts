import { TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import { provideHttpClient } from "@angular/common/http";
import { provideHttpClientTesting } from "@angular/common/http/testing";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { ActivatedRoute } from "@angular/router";
import { Subject, NEVER, throwError, Observable } from "rxjs";
import { vi } from "vitest";
import { GraphComponent } from "./graph";
import { GraphService } from "./graph.service";
import type { AnalysisResult } from "@route-atlas/shared";

const SAMPLE_RESULT: AnalysisResult = {
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
    {
      id: "screen_about",
      path: "/about",
      componentFile: "app/about/page.tsx",
      label: "About",
      description: "About page",
      variants: [
        {
          id: "v1",
          label: "Loading",
          condition: "Fetching data",
          type: "loading",
        },
      ],
    },
  ],
  transitions: [
    {
      id: "t1",
      from: "screen_home",
      to: "screen_about",
      trigger: "Click about link",
      method: "Link",
    },
  ],
};

describe("GraphComponent", () => {
  let mockFetchResult: ReturnType<typeof vi.fn>;
  let routerNavigateSpy: ReturnType<typeof vi.fn>;

  function setup(
    jobId: string | null = "test-job-id",
    fetchResult$: Observable<AnalysisResult> = NEVER as Observable<AnalysisResult>,
  ) {
    mockFetchResult = vi.fn().mockReturnValue(fetchResult$);
    routerNavigateSpy = vi.fn();

    const mockGraphService = {
      fetchResult: mockFetchResult,
    };

    const mockRouter = {
      navigate: routerNavigateSpy,
    };

    TestBed.configureTestingModule({
      imports: [GraphComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideAnimationsAsync(),
        { provide: GraphService, useValue: mockGraphService },
        { provide: Router, useValue: mockRouter },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: {
                get: (key: string) => (key === "jobId" ? jobId : null),
              },
            },
          },
        },
      ],
    });

    const fixture = TestBed.createComponent(GraphComponent);
    fixture.detectChanges();
    return fixture;
  }

  it("should create the component", () => {
    const fixture = setup();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it("should fetch result with the jobId from route", () => {
    setup("my-job-id");
    expect(mockFetchResult).toHaveBeenCalledWith("my-job-id");
  });

  it("should show error when no jobId is provided", () => {
    const fixture = setup(null);
    expect(fixture.componentInstance.errorMessage()).toBe(
      "Job ID is not specified.",
    );
    expect(fixture.componentInstance.loading()).toBe(false);
    expect(mockFetchResult).not.toHaveBeenCalled();
  });

  it("should remain loading while waiting for data", () => {
    const fixture = setup("test-job", NEVER);
    expect(fixture.componentInstance.loading()).toBe(true);
  });

  it("should set loading to false after data arrives", () => {
    const subject = new Subject<AnalysisResult>();
    const fixture = setup("test-job", subject.asObservable());
    expect(fixture.componentInstance.loading()).toBe(true);

    subject.next(SAMPLE_RESULT);
    fixture.detectChanges();

    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it("should show error on fetch failure", () => {
    const fixture = setup(
      "bad-job",
      throwError(() => ({ error: { message: "Job not found" } })),
    );
    fixture.detectChanges();

    expect(fixture.componentInstance.errorMessage()).toBe("Job not found");
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it("should navigate back to repos on goBack()", () => {
    const fixture = setup();
    fixture.componentInstance.goBack();
    expect(routerNavigateSpy).toHaveBeenCalledWith(["/repos"]);
  });

  it("should close detail panel and set selectedNode to null", () => {
    const fixture = setup();

    // Manually set a selected node
    fixture.componentInstance.selectedNode.set({
      id: "screen_home",
      label: "Home",
      path: "/",
      componentFile: "app/page.tsx",
      description: "Home page",
      variants: [],
      outgoingTransitions: [],
    });
    expect(fixture.componentInstance.selectedNode()).not.toBeNull();

    fixture.componentInstance.closeDetailPanel();
    expect(fixture.componentInstance.selectedNode()).toBeNull();
  });

  it("should show error container when errorMessage is set", () => {
    const fixture = setup(
      "bad-job",
      throwError(() => ({ error: { message: "Not found" } })),
    );
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const errorMsg = compiled.querySelector(".error-message");
    expect(errorMsg?.textContent).toContain("Not found");
  });

  it("should show back button in error state", () => {
    const fixture = setup(
      "bad-job",
      throwError(() => ({ error: { message: "Error" } })),
    );
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const btn = compiled.querySelector("button[mat-flat-button]");
    expect(btn?.textContent).toContain("Back to repositories");
  });

  it("should store analysis result after data arrives", () => {
    const subject = new Subject<AnalysisResult>();
    const fixture = setup("test-job", subject.asObservable());

    subject.next(SAMPLE_RESULT);
    fixture.detectChanges();

    // The component stores analysisResult internally, which we can verify
    // indirectly via loading being false and no error
    expect(fixture.componentInstance.loading()).toBe(false);
    expect(fixture.componentInstance.errorMessage()).toBeNull();
  });

  it("should handle generic error without error.message", () => {
    const fixture = setup(
      "bad-job",
      throwError(() => ({ message: "Generic error" })),
    );
    fixture.detectChanges();

    expect(fixture.componentInstance.errorMessage()).toBe("Generic error");
  });

  it("should fallback to default error message", () => {
    const fixture = setup(
      "bad-job",
      throwError(() => ({})),
    );
    fixture.detectChanges();

    expect(fixture.componentInstance.errorMessage()).toBe(
      "Failed to load analysis result.",
    );
  });
});
