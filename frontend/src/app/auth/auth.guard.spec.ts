import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { authGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { UrlTree } from "@angular/router";
import {
  ActivatedRouteSnapshot,
  RouterStateSnapshot,
  provideRouter,
} from "@angular/router";
import { firstValueFrom, isObservable } from "rxjs";
import {
  Component,
  runInInjectionContext,
  EnvironmentInjector,
} from "@angular/core";

@Component({ selector: "app-dummy", template: "", standalone: true })
class DummyComponent {}

describe("authGuard", () => {
  let httpTesting: HttpTestingController;
  let injector: EnvironmentInjector;

  const mockRoute = {} as ActivatedRouteSnapshot;
  const mockState = { url: "/protected" } as RouterStateSnapshot;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: "login", component: DummyComponent }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    httpTesting = TestBed.inject(HttpTestingController);
    injector = TestBed.inject(EnvironmentInjector);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  it("should redirect to /login when not authenticated", async () => {
    const result$ = runInInjectionContext(injector, () =>
      authGuard(mockRoute, mockState),
    );

    // The guard returns an observable
    if (isObservable(result$)) {
      const resultPromise = firstValueFrom(result$);

      const req = httpTesting.expectOne("/api/auth/me");
      req.flush(
        { error: "unauthorized" },
        { status: 401, statusText: "Unauthorized" },
      );

      const result = await resultPromise;
      expect(result).toBeInstanceOf(UrlTree);
      expect((result as UrlTree).toString()).toBe("/login");
    } else {
      // Should not reach here
      expect(result$).not.toBe(true);
    }
  });

  it("should allow access when authenticated", async () => {
    const result$ = runInInjectionContext(injector, () =>
      authGuard(mockRoute, mockState),
    );

    if (isObservable(result$)) {
      const resultPromise = firstValueFrom(result$);

      const req = httpTesting.expectOne("/api/auth/me");
      req.flush({
        login: "testuser",
        avatarUrl: "https://github.com/testuser.png",
        name: "Test User",
        hasCopilot: true,
      });

      const result = await resultPromise;
      expect(result).toBe(true);
    }
  });

  it("should return true immediately if already authenticated", () => {
    // Pre-authenticate
    const authService = TestBed.inject(AuthService);
    authService.checkAuth().subscribe();
    httpTesting.expectOne("/api/auth/me").flush({
      login: "testuser",
      avatarUrl: "https://github.com/testuser.png",
      name: "Test User",
      hasCopilot: true,
    });

    // Guard should return true synchronously
    const result = runInInjectionContext(injector, () =>
      authGuard(mockRoute, mockState),
    );
    expect(result).toBe(true);
  });
});
