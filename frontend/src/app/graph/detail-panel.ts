/**
 * Detail Panel Component
 *
 * Shows detailed information about a selected screen node:
 * - Screen name, path, and component file
 * - Variant list with type, label, and condition
 * - Outgoing transitions
 *
 * Reference: SPEC.md §7.2
 */

import { Component, input, output } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatChipsModule } from "@angular/material/chips";
import { MatIconModule } from "@angular/material/icon";
import { MatIconButton } from "@angular/material/button";
import { MatDividerModule } from "@angular/material/divider";
import { MatListModule } from "@angular/material/list";
import type { Variant, Transition } from "@route-atlas/shared";

export interface SelectedNodeData {
  id: string;
  label: string;
  path: string;
  componentFile: string;
  description: string;
  variants: Variant[];
  outgoingTransitions: Transition[];
}

@Component({
  selector: "app-detail-panel",
  standalone: true,
  imports: [
    MatCardModule,
    MatChipsModule,
    MatIconModule,
    MatIconButton,
    MatDividerModule,
    MatListModule,
  ],
  templateUrl: "./detail-panel.html",
  styleUrl: "./detail-panel.scss",
})
export class DetailPanelComponent {
  readonly node = input.required<SelectedNodeData>();
  readonly closed = output<void>();

  /** Return a human-readable label for a variant type. */
  variantTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      loading: "Loading",
      error: "Error",
      empty: "Empty",
      auth_required: "Auth",
      permission: "Permission",
      responsive: "Responsive",
      conditional: "Conditional",
    };
    return labels[type] ?? type;
  }

  /** Return a mat-icon name for a variant type. */
  variantTypeIcon(type: string): string {
    const icons: Record<string, string> = {
      loading: "hourglass_empty",
      error: "error_outline",
      empty: "inbox",
      auth_required: "lock",
      permission: "admin_panel_settings",
      responsive: "devices",
      conditional: "call_split",
    };
    return icons[type] ?? "label";
  }

  close(): void {
    this.closed.emit();
  }
}
