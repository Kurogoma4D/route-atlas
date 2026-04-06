import { Injectable, inject, signal, computed } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { catchError, of, tap } from "rxjs";
import type { UserInfo } from "@route-atlas/shared";

export interface AuthUser extends UserInfo {
  hasCopilot: boolean;
}

@Injectable({ providedIn: "root" })
export class AuthService {
  private http = inject(HttpClient);
  private apiBase = "/api/auth";

  private _user = signal<AuthUser | null>(null);
  private _loading = signal(true);
  private _error = signal<string | null>(null);

  readonly user = this._user.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);

  /** Check current auth status by calling /api/auth/me */
  checkAuth() {
    this._loading.set(true);
    return this.http
      .get<AuthUser>(`${this.apiBase}/me`, { withCredentials: true })
      .pipe(
        tap((user) => {
          this._user.set(user);
          this._loading.set(false);
          this._error.set(null);
        }),
        catchError(() => {
          this._user.set(null);
          this._loading.set(false);
          return of(null);
        }),
      );
  }

  /** Redirect to GitHub OAuth */
  login() {
    window.location.href = `${this.apiBase}/github`;
  }

  /** Logout and clear state */
  logout() {
    return this.http
      .post(`${this.apiBase}/logout`, {}, { withCredentials: true })
      .pipe(
        tap(() => {
          this._user.set(null);
          this._error.set(null);
        }),
        catchError((err) => {
          this._error.set("Failed to logout");
          console.error("Logout error:", err);
          return of(null);
        }),
      );
  }
}
