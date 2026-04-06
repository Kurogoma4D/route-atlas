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
      {
        path: "repos",
        loadComponent: () =>
          import("./repos/repos").then((m) => m.ReposComponent),
      },
      {
        path: "",
        redirectTo: "repos",
        pathMatch: "full" as const,
      },
      // Future protected routes (e.g., /analyze/:jobId, /graph/:jobId)
      // will be added here
    ],
  },
  {
    path: "**",
    redirectTo: "",
  },
];
