import { Routes } from "@angular/router";
import { authGuard } from "./auth/auth.guard";

export const routes: Routes = [
  {
    path: "login",
    loadComponent: () => import("./login/login").then((m) => m.LoginComponent),
  },
  {
    path: "",
    canActivate: [authGuard],
    children: [
      // Future protected routes (e.g., /repos, /analyze/:jobId, /graph/:jobId)
      // will be added here
    ],
  },
  {
    path: "**",
    redirectTo: "",
  },
];
