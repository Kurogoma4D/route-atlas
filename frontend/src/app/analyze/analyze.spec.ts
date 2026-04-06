import { TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import { provideHttpClient } from "@angular/common/http";
import { provideHttpClientTesting } from "@angular/common/http/testing";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { ActivatedRoute } from "@angular/router";
import { Subject } from "rxjs";
import { vi } from "vitest";
import { AnalyzeComponent } from "./analyze";
import { AnalyzeService } from "./analyze.service";
import type { SseEvent } from "./analyze.service";

describe("AnalyzeComponent", () => {
  let sseSubject: Subject<SseEvent>;
  let mockConnectToJob: ReturnType<typeof vi.fn>;
  let routerNavigateSpy: ReturnType<typeof vi.fn>;

  function setup(jobId: string | null = "test-job-id") {
    sseSubject = new Subject<SseEvent>();
    mockConnectToJob = vi.fn().mockReturnValue(sseSubject.asObservable());
    routerNavigateSpy = vi.fn();

    const mockAnalyzeService = {
      connectToJob: mockConnectToJob,
    };

    const mockRouter = {
      navigate: routerNavigateSpy,
    };

    TestBed.configureTestingModule({
      imports: [AnalyzeComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideAnimationsAsync(),
        { provide: AnalyzeService, useValue: mockAnalyzeService },
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

    const fixture = TestBed.createComponent(AnalyzeComponent);
    fixture.detectChanges();
    return fixture;
  }

  it("should create the component", () => {
    const fixture = setup();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it("should connect to the job on init", () => {
    setup("my-job-id");
    expect(mockConnectToJob).toHaveBeenCalledWith("my-job-id");
  });

  it("should show error when no jobId is provided", async () => {
    const fixture = setup(null);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.errorMessage()).toBe(
      "ジョブIDが指定されていません。",
    );
    expect(mockConnectToJob).not.toHaveBeenCalled();
  });

  it("should update current step on progress event", async () => {
    const fixture = setup();

    sseSubject.next({
      type: "progress",
      data: { step: "detecting_framework", message: "Detecting..." },
    });
    fixture.detectChanges();

    expect(fixture.componentInstance.currentStep()).toBe("detecting_framework");
    expect(fixture.componentInstance.currentStepIndex()).toBe(0);

    sseSubject.next({
      type: "progress",
      data: { step: "fetching_files", message: "Fetching..." },
    });
    fixture.detectChanges();

    expect(fixture.componentInstance.currentStep()).toBe("fetching_files");
    expect(fixture.componentInstance.currentStepIndex()).toBe(1);
  });

  it("should navigate to graph view on complete event", () => {
    setup("my-job-id");

    sseSubject.next({
      type: "complete",
      data: { framework: "angular", screens: [], transitions: [] },
    });

    expect(routerNavigateSpy).toHaveBeenCalledWith(["/graph", "my-job-id"]);
  });

  it("should show error message on error event", async () => {
    const fixture = setup();

    sseSubject.next({
      type: "error",
      data: { message: "Something went wrong" },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.errorMessage()).toBe(
      "Something went wrong",
    );

    const compiled = fixture.nativeElement as HTMLElement;
    const errorMsg = compiled.querySelector(".error-message");
    expect(errorMsg?.textContent).toContain("Something went wrong");
  });

  it("should show back button on error", async () => {
    const fixture = setup();

    sseSubject.next({
      type: "error",
      data: { message: "Failed" },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const backButton = compiled.querySelector("button[mat-flat-button]");
    expect(backButton?.textContent).toContain("戻る");
  });

  it("should navigate back to repos on goBack()", () => {
    const fixture = setup();
    fixture.componentInstance.goBack();
    expect(routerNavigateSpy).toHaveBeenCalledWith(["/repos"]);
  });

  it("should mark previous steps as completed", () => {
    const fixture = setup();

    sseSubject.next({
      type: "progress",
      data: { step: "analyzing_routes", message: "Analyzing..." },
    });
    fixture.detectChanges();

    const component = fixture.componentInstance;
    expect(component.isStepCompleted("detecting_framework")).toBe(true);
    expect(component.isStepCompleted("fetching_files")).toBe(true);
    expect(component.isStepCompleted("analyzing_routes")).toBe(false);
    expect(component.isStepActive("analyzing_routes")).toBe(true);
    expect(component.isStepActive("detecting_framework")).toBe(false);
  });

  it("should display the stepper with all step labels", async () => {
    const fixture = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const stepLabels = compiled.querySelectorAll(".step-label");
    expect(stepLabels.length).toBe(5);
    expect(stepLabels[0].textContent).toContain("フレームワーク検出中...");
    expect(stepLabels[1].textContent).toContain("ファイル取得中...");
    expect(stepLabels[2].textContent).toContain("ルート解析中...");
    expect(stepLabels[3].textContent).toContain("バリエーション解析中...");
    expect(stepLabels[4].textContent).toContain("遷移解析中...");
  });

  it("should set error message when SSE observable errors", () => {
    const fixture = setup();

    sseSubject.error(new Error("Connection lost"));
    fixture.detectChanges();

    expect(fixture.componentInstance.errorMessage()).toBe(
      "解析サーバーとの接続が切れました。",
    );
  });
});
