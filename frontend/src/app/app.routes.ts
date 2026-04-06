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
      {
        path: "analyze/:jobId",
        loadComponent: () =>
          import("./analyze/analyze").then((m) => m.AnalyzeComponent),
      },
      {
        path: "graph/:jobId",
        loadComponent: () =>
          import("./graph/graph").then((m) => m.GraphComponent),
      },
    ],
  },
  {
    path: "**",
    redirectTo: "",
  },
];
