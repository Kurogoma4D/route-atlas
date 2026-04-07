import { Injectable, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import {
  Observable,
  timer,
  switchMap,
  takeWhile,
  map,
  catchError,
  of,
} from "rxjs";
import { environment } from "../../environments/environment";

/**
 * Steps emitted during analysis progress polling.
 */
export type AnalysisStep =
  | "detecting_framework"
  | "fetching_files"
  | "analyzing_routes"
  | "analyzing_variants"
  | "analyzing_transitions";

export interface ProgressEvent {
  step: AnalysisStep;
  message: string;
}

export interface StartAnalysisRequest {
  owner: string;
  repo: string;
  branch: string;
  model?: string;
}

export interface StartAnalysisResponse {
  jobId: string;
}

/**
 * Job state returned by GET /api/analyze/:jobId
 */
export interface JobPollResponse {
  status: "pending" | "running" | "complete" | "error";
  step: string;
  message: string;
  error?: string;
}

export type AnalysisEvent =
  | { type: "progress"; data: ProgressEvent }
  | { type: "complete"; data: unknown }
  | { type: "error"; data: { message: string } };

/**
 * @deprecated Use `AnalysisEvent` instead. Kept for backward compatibility.
 */
export type SseEvent = AnalysisEvent;

/** Default polling interval in milliseconds. */
const POLL_INTERVAL_MS = 2500;

@Injectable({ providedIn: "root" })
export class AnalyzeService {
  private http = inject(HttpClient);
  private apiBase = `${environment.apiBaseUrl}/api/analyze`;

  /**
   * Start an analysis job. Returns the jobId.
   */
  startAnalysis(
    request: StartAnalysisRequest,
  ): Observable<StartAnalysisResponse> {
    return this.http.post<StartAnalysisResponse>(this.apiBase, request, {
      withCredentials: true,
    });
  }

  /**
   * Poll the job status endpoint at a regular interval.
   * Emits AnalysisEvent objects and completes when the job reaches
   * a terminal state (`complete` or `error`).
   *
   * When the job completes, the service fetches the full result from
   * GET /api/analyze/:jobId/result and emits a `complete` event.
   */
  pollJob(jobId: string): Observable<AnalysisEvent> {
    const pollUrl = `${this.apiBase}/${encodeURIComponent(jobId)}`;
    const resultUrl = `${this.apiBase}/${encodeURIComponent(jobId)}/result`;

    return timer(0, POLL_INTERVAL_MS).pipe(
      switchMap(() =>
        this.http.get<JobPollResponse>(pollUrl, { withCredentials: true }).pipe(
          catchError(() =>
            of<JobPollResponse>({
              status: "error",
              step: "error",
              message: "Connection to analysis server lost",
              error: "Connection to analysis server lost",
            }),
          ),
        ),
      ),
      switchMap((response): Observable<AnalysisEvent> => {
        if (response.status === "complete") {
          // Fetch the full result
          return this.http
            .get<unknown>(resultUrl, { withCredentials: true })
            .pipe(
              map(
                (result): AnalysisEvent => ({
                  type: "complete",
                  data: result,
                }),
              ),
              catchError(() =>
                of<AnalysisEvent>({
                  type: "error",
                  data: { message: "Failed to fetch analysis result" },
                }),
              ),
            );
        }

        if (response.status === "error") {
          return of<AnalysisEvent>({
            type: "error",
            data: { message: response.error ?? response.message },
          });
        }

        // pending or running — emit progress
        return of<AnalysisEvent>({
          type: "progress",
          data: {
            step: response.step as AnalysisStep,
            message: response.message,
          },
        });
      }),
      // Complete synchronously after a terminal event (inclusive mode)
      takeWhile((event) => event.type === "progress", true),
    );
  }

  /**
   * @deprecated Use `pollJob` instead. Kept for backward compatibility.
   */
  connectToJob(jobId: string): Observable<AnalysisEvent> {
    return this.pollJob(jobId);
  }
}
