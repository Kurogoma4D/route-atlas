import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { App } from "./app";

describe("App", () => {
  let httpTesting: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  it("should create the app", () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    // Flush the checkAuth request triggered by ngOnInit
    httpTesting
      .expectOne("/api/auth/me")
      .flush(
        { error: "unauthorized" },
        { status: 401, statusText: "Unauthorized" },
      );
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it("should render toolbar with Route Atlas", async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    httpTesting
      .expectOne("/api/auth/me")
      .flush(
        { error: "unauthorized" },
        { status: 401, statusText: "Unauthorized" },
      );
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector("mat-toolbar")?.textContent).toContain(
      "Route Atlas",
    );
  });

  it("should show user menu when authenticated", async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    httpTesting.expectOne("/api/auth/me").flush({
      login: "testuser",
      avatarUrl: "https://github.com/testuser.png",
      name: "Test User",
      hasCopilot: true,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const avatar = compiled.querySelector(".user-avatar") as HTMLImageElement;
    expect(avatar).toBeTruthy();
    expect(avatar.src).toContain("testuser.png");
  });
});
