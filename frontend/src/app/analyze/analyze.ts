import {
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
  computed,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatStepperModule } from "@angular/material/stepper";
import { AnalyzeService } from "./analyze.service";
import type { AnalysisStep } from "./analyze.service";

interface StepDefinition {
  key: AnalysisStep;
  label: string;
}

@Component({
  selector: "app-analyze",
  standalone: true,
  imports: [
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    MatStepperModule,
  ],
  templateUrl: "./analyze.html",
  styleUrl: "./analyze.scss",
})
export class AnalyzeComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private analyzeService = inject(AnalyzeService);
  private destroyRef = inject(DestroyRef);

  readonly steps: StepDefinition[] = [
    { key: "detecting_framework", label: "フレームワーク検出中..." },
    { key: "fetching_files", label: "ファイル取得中..." },
    { key: "analyzing_routes", label: "ルート解析中..." },
    { key: "analyzing_variants", label: "バリエーション解析中..." },
    { key: "analyzing_transitions", label: "遷移解析中..." },
  ];

  /** The step key currently active (most recently received from SSE). */
  readonly currentStep = signal<AnalysisStep | null>(null);

  /** Error message to display, or null if no error. */
  readonly errorMessage = signal<string | null>(null);

  /** Computed index of the current step in the steps array. */
  readonly currentStepIndex = computed(() => {
    const step = this.currentStep();
    if (!step) return 0;
    const idx = this.steps.findIndex((s) => s.key === step);
    return idx >= 0 ? idx : 0;
  });

  ngOnInit() {
    const jobId = this.route.snapshot.paramMap.get("jobId");
    if (!jobId) {
      this.errorMessage.set("ジョブIDが指定されていません。");
      return;
    }
    this.connectToJob(jobId);
  }

  /** Check if a step is the currently active one. */
  isStepActive(key: AnalysisStep): boolean {
    return this.currentStep() === key && !this.errorMessage();
  }

  /** Check if a step is completed (before the current step). */
  isStepCompleted(key: AnalysisStep): boolean {
    const current = this.currentStep();
    if (!current) return false;
    const currentIdx = this.steps.findIndex((s) => s.key === current);
    const stepIdx = this.steps.findIndex((s) => s.key === key);
    return stepIdx < currentIdx;
  }

  /** Navigate back to the repo selection screen. */
  goBack() {
    this.router.navigate(["/repos"]);
  }

  private connectToJob(jobId: string) {
    this.currentStep.set("detecting_framework");
    this.analyzeService
      .connectToJob(jobId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          switch (event.type) {
            case "progress":
              this.currentStep.set(event.data.step);
              break;
            case "complete":
              this.router.navigate(["/graph", jobId]);
              break;
            case "error":
              this.errorMessage.set(event.data.message);
              break;
          }
        },
        error: () => {
          this.errorMessage.set("解析サーバーとの接続が切れました。");
        },
      });
  }
}
