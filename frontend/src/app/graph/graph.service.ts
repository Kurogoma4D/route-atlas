/**
 * Graph Service
 *
 * Fetches completed analysis results from the backend and converts
 * them to Cytoscape.js elements for rendering.
 *
 * Reference: SPEC.md §7.2
 */

import { Injectable, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { Observable, map } from "rxjs";
import type { ElementDefinition } from "cytoscape";
import type { AnalysisResult } from "@route-atlas/shared";
import { convertToCytoscapeElements } from "./graph-converter";

@Injectable({ providedIn: "root" })
export class GraphService {
  private http = inject(HttpClient);
  private apiBase = "/api/analyze";

  /**
   * Fetch the analysis result for a completed job.
   */
  fetchResult(jobId: string): Observable<AnalysisResult> {
    return this.http.get<AnalysisResult>(
      `${this.apiBase}/${encodeURIComponent(jobId)}/result`,
      { withCredentials: true },
    );
  }

  /**
   * Fetch and convert the analysis result to Cytoscape elements.
   */
  fetchGraphElements(jobId: string): Observable<{
    result: AnalysisResult;
    elements: ElementDefinition[];
  }> {
    return this.fetchResult(jobId).pipe(
      map((result) => ({
        result,
        elements: convertToCytoscapeElements(result),
      })),
    );
  }
}
