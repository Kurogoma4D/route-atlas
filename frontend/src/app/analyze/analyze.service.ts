import { Injectable, inject, NgZone } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { Observable } from "rxjs";

/**
 * Steps emitted by the SSE progress stream.
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

export type SseEvent =
  | { type: "progress"; data: ProgressEvent }
  | { type: "complete"; data: unknown }
  | { type: "error"; data: { message: string } };

@Injectable({ providedIn: "root" })
export class AnalyzeService {
  private http = inject(HttpClient);
  private ngZone = inject(NgZone);
  private apiBase = "/api/analyze";

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
   * Connect to the SSE stream for a given job.
   * Returns an Observable that emits SseEvent objects and completes
   * when the server sends a `complete` event, or errors on `error` event.
   */
  connectToJob(jobId: string): Observable<SseEvent> {
    return new Observable<SseEvent>((subscriber) => {
      const url = `${this.apiBase}/${encodeURIComponent(jobId)}`;
      const eventSource = new EventSource(url, { withCredentials: true });

      eventSource.addEventListener("progress", (event: MessageEvent) => {
        this.ngZone.run(() => {
          try {
            const data = JSON.parse(event.data) as ProgressEvent;
            subscriber.next({ type: "progress", data });
          } catch {
            // Ignore malformed events
          }
        });
      });

      eventSource.addEventListener("complete", (event: MessageEvent) => {
        this.ngZone.run(() => {
          try {
            const data = JSON.parse(event.data) as unknown;
            subscriber.next({ type: "complete", data });
            subscriber.complete();
          } catch {
            subscriber.complete();
          } finally {
            eventSource.close();
          }
        });
      });

      eventSource.addEventListener("error", (event: MessageEvent) => {
        this.ngZone.run(() => {
          // The SSE 'error' event could be a named event with data,
          // or a connection error with no data.
          if (event.data) {
            try {
              const data = JSON.parse(event.data) as { message: string };
              subscriber.next({ type: "error", data });
            } catch {
              subscriber.next({
                type: "error",
                data: { message: "Unknown analysis error" },
              });
            }
          } else {
            subscriber.next({
              type: "error",
              data: { message: "Connection to analysis server lost" },
            });
          }
          eventSource.close();
        });
      });

      // Cleanup on unsubscribe
      return () => {
        eventSource.close();
      };
    });
  }
}
