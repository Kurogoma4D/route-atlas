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
import {
  trigger,
  transition,
  style,
  animate,
} from "@angular/animations";
import { AnalyzeService } from "./analyze.service";
import type { AnalysisStep, StepMetadata } from "./analyze.service";

interface StepDefinition {
  key: AnalysisStep;
  label: string;
}

const FRAMEWORK_LABELS: Record<string, string> = {
  "nextjs-app": "Next.js (App Router)",
  "nextjs-pages": "Next.js (Pages Router)",
  "react-router": "React Router",
  angular: "Angular",
  "vue-router": "Vue Router",
  nuxt: "Nuxt",
  sveltekit: "SvelteKit",
  remix: "Remix",
  gatsby: "Gatsby",
  astro: "Astro",
  "solid-start": "SolidStart",
  "qwik-city": "Qwik City",
  ember: "Ember.js",
  "plain-html": "HTML",
  "tanstack-router": "TanStack Router",
  "android-navigation": "Android Navigation",
  "android-compose-navigation": "Compose Navigation",
  "ios-swiftui": "SwiftUI",
  "ios-uikit": "UIKit",
  "flutter-go-router": "Flutter go_router",
  "flutter-auto-route": "Flutter auto_route",
  "flutter-navigator": "Flutter Navigator",
  "expo-router": "Expo Router",
  "react-navigation": "React Navigation",
};

const PLATFORM_LABELS: Record<string, string> = {
  web: "Web",
  android: "Android",
  ios: "iOS",
  flutter: "Flutter",
};

@Component({
  selector: "app-analyze",
  standalone: true,
  imports: [
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
  ],
  templateUrl: "./analyze.html",
  styleUrl: "./analyze.scss",
  animations: [
    trigger("stepComplete", [
      transition(":enter", [
        style({ opacity: 0, transform: "scale(0.6)" }),
        animate(
          "300ms cubic-bezier(0.4, 0, 0.2, 1)",
          style({ opacity: 1, transform: "scale(1)" }),
        ),
      ]),
    ]),
    trigger("metadataReveal", [
      transition(":enter", [
        style({ opacity: 0, transform: "translateY(4px)", maxHeight: "0" }),
        animate(
          "350ms 100ms cubic-bezier(0.4, 0, 0.2, 1)",
          style({ opacity: 1, transform: "translateY(0)", maxHeight: "80px" }),
        ),
      ]),
    ]),
  ],
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

  readonly currentStep = signal<AnalysisStep | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly stepMetadata = signal<StepMetadata>({});

  readonly currentStepIndex = computed(() => {
    const step = this.currentStep();
    if (!step) return 0;
    const idx = this.steps.findIndex((s) => s.key === step);
    return idx >= 0 ? idx : 0;
  });

  readonly frameworkLabel = computed(() => {
    const fw = this.stepMetadata().framework;
    if (!fw) return null;
    return FRAMEWORK_LABELS[fw] ?? fw;
  });

  readonly platformLabel = computed(() => {
    const p = this.stepMetadata().platform;
    if (!p) return null;
    return PLATFORM_LABELS[p] ?? p;
  });

  readonly fileCountLabel = computed(() => {
    const meta = this.stepMetadata();
    if (meta.routingFileCount == null) return null;
    return `ルーティング: ${meta.routingFileCount}件, コンポーネント: ${meta.componentFileCount ?? 0}件`;
  });

  ngOnInit() {
    const jobId = this.route.snapshot.paramMap.get("jobId");
    if (!jobId) {
      this.errorMessage.set("ジョブIDが指定されていません。");
      return;
    }
    this.connectToJob(jobId);
  }

  isStepActive(key: AnalysisStep): boolean {
    return this.currentStep() === key && !this.errorMessage();
  }

  isStepCompleted(key: AnalysisStep): boolean {
    const current = this.currentStep();
    if (!current) return false;
    const currentIdx = this.steps.findIndex((s) => s.key === current);
    const stepIdx = this.steps.findIndex((s) => s.key === key);
    return stepIdx < currentIdx;
  }

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
              this.advanceToStep(event.data.step);
              if (event.data.metadata) {
                this.stepMetadata.update((prev) => ({
                  ...prev,
                  ...event.data.metadata,
                }));
              }
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

  private advanceToStep(targetStep: AnalysisStep) {
    const targetIdx = this.steps.findIndex((s) => s.key === targetStep);
    const currentIdx = this.currentStepIndex();

    if (targetIdx <= currentIdx) {
      this.currentStep.set(targetStep);
      return;
    }

    // Stagger through intermediate steps for smooth animation
    if (targetIdx - currentIdx > 1) {
      let i = currentIdx + 1;
      const advance = () => {
        if (i < targetIdx) {
          this.currentStep.set(this.steps[i].key);
          i++;
          setTimeout(advance, 200);
        } else {
          this.currentStep.set(targetStep);
        }
      };
      advance();
    } else {
      this.currentStep.set(targetStep);
    }
  }
}
