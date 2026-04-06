import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { AuthService } from "./auth.service";

describe("AuthService", () => {
  let service: AuthService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });

  it("should start in loading state", () => {
    expect(service.loading()).toBe(true);
    expect(service.isAuthenticated()).toBe(false);
  });

  describe("checkAuth", () => {
    it("should set user on successful auth check", () => {
      const mockUser = {
        login: "testuser",
        avatarUrl: "https://github.com/testuser.png",
        name: "Test User",
        hasCopilot: true,
      };

      service.checkAuth().subscribe();

      const req = httpTesting.expectOne("/api/auth/me");
      expect(req.request.method).toBe("GET");
      expect(req.request.withCredentials).toBe(true);
      req.flush(mockUser);

      expect(service.user()).toEqual(mockUser);
      expect(service.isAuthenticated()).toBe(true);
      expect(service.loading()).toBe(false);
    });

    it("should clear user on auth check failure", () => {
      service.checkAuth().subscribe();

      const req = httpTesting.expectOne("/api/auth/me");
      req.flush(
        { error: "unauthorized" },
        { status: 401, statusText: "Unauthorized" },
      );

      expect(service.user()).toBeNull();
      expect(service.isAuthenticated()).toBe(false);
      expect(service.loading()).toBe(false);
    });
  });

  describe("logout", () => {
    it("should clear user state on logout", () => {
      service.logout().subscribe();

      const req = httpTesting.expectOne("/api/auth/logout");
      expect(req.request.method).toBe("POST");
      expect(req.request.withCredentials).toBe(true);
      req.flush({ message: "Logged out" });

      expect(service.user()).toBeNull();
      expect(service.isAuthenticated()).toBe(false);
    });
  });
});
