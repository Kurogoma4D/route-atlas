import { Injectable, inject } from "@angular/core";
import { HttpClient, HttpParams } from "@angular/common/http";
import { Observable } from "rxjs";
import type { ReposResponse, BranchesResponse } from "@route-atlas/shared";
import { environment } from "../../environments/environment";

@Injectable({ providedIn: "root" })
export class ReposService {
  private http = inject(HttpClient);
  private apiBase = `${environment.apiBaseUrl}/api/repos`;

  /**
   * Fetch the authenticated user's repositories with pagination.
   */
  getRepos(page: number = 1, perPage: number = 30): Observable<ReposResponse> {
    const params = new HttpParams()
      .set("page", String(page))
      .set("per_page", String(perPage));

    return this.http.get<ReposResponse>(this.apiBase, {
      params,
      withCredentials: true,
    });
  }

  /**
   * Fetch branches for a specific repository.
   */
  getBranches(owner: string, repo: string): Observable<BranchesResponse> {
    return this.http.get<BranchesResponse>(
      `${this.apiBase}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
      { withCredentials: true },
    );
  }
}
