import { inject } from "@angular/core";
import { Router } from "@angular/router";
import type { CanActivateFn } from "@angular/router";
import { AuthService } from "./auth.service";
import { map, take } from "rxjs";

export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // If already loaded and authenticated, allow
  if (!authService.loading() && authService.isAuthenticated()) {
    return true;
  }

  // Otherwise, check auth status
  return authService.checkAuth().pipe(
    take(1),
    map((user) => {
      if (user) {
        return true;
      }
      return router.createUrlTree(["/login"]);
    }),
  );
};
