import {
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
  computed,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatListModule } from "@angular/material/list";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatChipsModule } from "@angular/material/chips";
import { ReposService } from "./repos.service";
import type { RepoInfo, BranchInfo } from "@route-atlas/shared";

@Component({
  selector: "app-repos",
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatChipsModule,
  ],
  templateUrl: "./repos.html",
  styleUrl: "./repos.scss",
})
export class ReposComponent implements OnInit {
  private reposService = inject(ReposService);
  private destroyRef = inject(DestroyRef);

  // Repos state
  readonly repos = signal<RepoInfo[]>([]);
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly error = signal<string | null>(null);
  readonly currentPage = signal(1);
  readonly hasNextPage = signal(false);
  readonly searchQuery = signal("");

  // Branch selection state
  readonly selectedRepo = signal<RepoInfo | null>(null);
  readonly branches = signal<BranchInfo[]>([]);
  readonly selectedBranch = signal<BranchInfo | null>(null);
  readonly loadingBranches = signal(false);
  readonly branchError = signal<string | null>(null);

  // Computed: filtered repos
  readonly filteredRepos = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return this.repos();
    return this.repos().filter(
      (repo) =>
        repo.name.toLowerCase().includes(query) ||
        (repo.description?.toLowerCase().includes(query) ?? false),
    );
  });

  // Computed: can start analysis
  readonly canStartAnalysis = computed(
    () => this.selectedRepo() !== null && this.selectedBranch() !== null,
  );

  ngOnInit() {
    this.loadRepos();
  }

  loadRepos() {
    this.loading.set(true);
    this.error.set(null);

    this.reposService
      .getRepos(1, 30)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.repos.set(response.repos);
          this.currentPage.set(response.page);
          this.hasNextPage.set(response.hasNextPage);
          this.loading.set(false);
        },
        error: () => {
          this.error.set("リポジトリの取得に失敗しました。");
          this.loading.set(false);
        },
      });
  }

  loadMore() {
    if (!this.hasNextPage() || this.loadingMore()) return;

    const nextPage = this.currentPage() + 1;
    this.loadingMore.set(true);

    this.reposService
      .getRepos(nextPage, 30)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.repos.update((prev) => [...prev, ...response.repos]);
          this.currentPage.set(response.page);
          this.hasNextPage.set(response.hasNextPage);
          this.loadingMore.set(false);
        },
        error: () => {
          this.error.set("追加のリポジトリ取得に失敗しました。");
          this.loadingMore.set(false);
        },
      });
  }

  onSearchInput(value: string) {
    this.searchQuery.set(value);
  }

  selectRepo(repo: RepoInfo) {
    this.selectedRepo.set(repo);
    this.selectedBranch.set(null);
    this.branches.set([]);
    this.loadBranches(repo);
  }

  private loadBranches(repo: RepoInfo) {
    this.loadingBranches.set(true);
    this.branchError.set(null);

    this.reposService
      .getBranches(repo.owner, repo.name)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.branches.set(response.branches);
          // Auto-select default branch
          const defaultBranch = response.branches.find(
            (b) => b.name === repo.defaultBranch,
          );
          if (defaultBranch) {
            this.selectedBranch.set(defaultBranch);
          }
          this.loadingBranches.set(false);
        },
        error: () => {
          this.branchError.set("ブランチの取得に失敗しました。");
          this.loadingBranches.set(false);
        },
      });
  }

  selectBranch(branch: BranchInfo) {
    this.selectedBranch.set(branch);
  }

  onStartAnalysis() {
    // Destination will be implemented in a future issue
    // For now, this is a placeholder
  }
}
