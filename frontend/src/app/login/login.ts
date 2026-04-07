import { Component, inject, OnInit, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { AuthService } from "../auth/auth.service";

@Component({
  selector: "app-login",
  standalone: true,
  imports: [MatButtonModule, MatIconModule],
  templateUrl: "./login.html",
  styleUrl: "./login.scss",
})
export class LoginComponent implements OnInit {
  private authService = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  errorMessage = signal<string | null>(null);

  ngOnInit() {
    // If already authenticated, redirect to home
    if (this.authService.isAuthenticated()) {
      this.router.navigate(["/"]);
      return;
    }

    // Check for error query params from OAuth callback
    const error = this.route.snapshot.queryParamMap.get("error");
    if (error) {
      this.errorMessage.set(this.getErrorMessage(error));
    }
  }

  onLogin() {
    this.authService.login();
  }

  private getErrorMessage(error: string): string {
    switch (error) {
      case "oauth_denied":
        return "GitHub の認可がキャンセルされました。";
      case "missing_code":
        return "認証コードが見つかりませんでした。";
      case "token_exchange_failed":
        return "認証に失敗しました。もう一度お試しください。";
      case "session_error":
        return "セッションエラーが発生しました。もう一度お試しください。";
      default:
        return "エラーが発生しました。もう一度お試しください。";
    }
  }
}
