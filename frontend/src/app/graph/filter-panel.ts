/**
 * Filter Panel Component
 *
 * Provides UI controls for filtering edges by transition type,
 * highlighting nodes by variant type, searching by screen name/path,
 * and exporting the graph as PNG or SVG.
 *
 * Reference: SPEC.md §7.2 — Graph operations
 */

import {
  Component,
  inject,
  input,
  output,
  signal,
  OnDestroy,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";
import { MatTooltipModule } from "@angular/material/tooltip";
import type { Core } from "cytoscape";
import type { VariantType } from "@route-atlas/shared";
import { GraphFilterService } from "./graph-filter.service";
import type { TransitionMethod } from "./graph-converter";

@Component({
  selector: "app-filter-panel",
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  templateUrl: "./filter-panel.html",
  styleUrl: "./filter-panel.scss",
})
export class FilterPanelComponent implements OnDestroy {
  private filterService = inject(GraphFilterService);

  /** The Cytoscape Core instance to operate on. */
  readonly cy = input<Core | null>(null);

  /** Emitted when the panel is closed. */
  readonly closed = output<void>();

  /** Expose filter state from service for template binding. */
  readonly transitionFilters = this.filterService.transitionFilters;
  readonly highlightedVariantType = this.filterService.highlightedVariantType;
  readonly searchQuery = this.filterService.searchQuery;

  /** Number of search matches found. */
  readonly searchResultCount = signal<number | null>(null);

  /** Timeout handle for search debounce. */
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Available variant types for the highlight selector. */
  readonly variantTypes: { value: VariantType; label: string }[] = [
    { value: "loading", label: "Loading" },
    { value: "error", label: "Error" },
    { value: "empty", label: "Empty" },
    { value: "auth_required", label: "Auth Required" },
    { value: "permission", label: "Permission" },
    { value: "responsive", label: "Responsive" },
    { value: "conditional", label: "Conditional" },
  ];

  /** Handle transition type checkbox toggle. */
  onTransitionToggle(method: TransitionMethod, checked: boolean): void {
    this.filterService.toggleTransitionType(method, checked, this.cy());
  }

  /** Handle variant highlight selection. */
  onVariantHighlightChange(value: VariantType | null): void {
    const cy = this.cy();
    if (cy) {
      this.filterService.applyVariantHighlight(cy, value);
    }
  }

  /** Handle search input with 300ms debounce. */
  onSearch(query: string): void {
    if (this.searchDebounceTimer !== null) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.searchDebounceTimer = null;
      const cy = this.cy();
      if (cy) {
        const count = this.filterService.searchAndFocus(cy, query);
        this.searchResultCount.set(query.trim() ? count : null);
      }
    }, 300);
  }

  ngOnDestroy(): void {
    if (this.searchDebounceTimer !== null) {
      clearTimeout(this.searchDebounceTimer);
    }
  }

  /** Export graph as PNG. */
  exportPng(): void {
    const cy = this.cy();
    if (cy) {
      this.filterService.exportPng(cy);
    }
  }

  /** Export graph as SVG. */
  exportSvg(): void {
    const cy = this.cy();
    if (cy) {
      this.filterService.exportSvg(cy);
    }
  }

  /** Close the filter panel. */
  close(): void {
    this.closed.emit();
  }
}
