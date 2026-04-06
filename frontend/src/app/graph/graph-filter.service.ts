/**
 * Graph Filter & Export Service
 *
 * Encapsulates filtering, highlighting, search, and export logic
 * that operates on a Cytoscape.js Core instance.
 *
 * Reference: SPEC.md §7.2 — Graph operations
 */

import { Injectable, signal } from "@angular/core";
import type { Core, CollectionReturnValue } from "cytoscape";
import type { TransitionMethod } from "./graph-converter";
import type { VariantType } from "@route-atlas/shared";

/** State describing which transition-type edges are visible. */
export interface TransitionFilters {
  link: boolean;
  programmatic: boolean;
  redirect: boolean;
}

@Injectable()
export class GraphFilterService {
  // -----------------------------------------------------------------------
  // State — signals for reactive UI binding
  // -----------------------------------------------------------------------

  /** Which transition types are currently visible (all on by default). */
  readonly transitionFilters = signal<TransitionFilters>({
    link: true,
    programmatic: true,
    redirect: true,
  });

  /** Variant type to highlight (null = no highlight). */
  readonly highlightedVariantType = signal<VariantType | null>(null);

  /** Current search query for screen name / path. */
  readonly searchQuery = signal<string>("");

  // -----------------------------------------------------------------------
  // Public API — filter operations
  // -----------------------------------------------------------------------

  /**
   * Toggle visibility of a single transition type and apply to graph.
   */
  toggleTransitionType(
    method: TransitionMethod,
    visible: boolean,
    cy: Core | null,
  ): void {
    this.transitionFilters.update((prev) => ({ ...prev, [method]: visible }));
    if (cy) {
      this.applyTransitionFilter(cy);
    }
  }

  /**
   * Apply transition-type filter — hide/show edges by their `method` data.
   */
  applyTransitionFilter(cy: Core): void {
    const filters = this.transitionFilters();
    const methods: TransitionMethod[] = ["link", "programmatic", "redirect"];
    for (const method of methods) {
      const edges = cy.edges(
        `[method = "${method}"]`,
      ) as CollectionReturnValue;
      if (filters[method]) {
        // show()/hide() are available at runtime but missing from @types/cytoscape
        (edges as unknown as { show(): void }).show();
      } else {
        (edges as unknown as { hide(): void }).hide();
      }
    }
  }

  /**
   * Highlight nodes that contain at least one variant of the given type.
   * Pass `null` to clear highlights.
   */
  applyVariantHighlight(cy: Core, variantType: VariantType | null): void {
    this.highlightedVariantType.set(variantType);

    // Remove previous highlight class from all nodes
    cy.nodes().removeClass("variant-highlight");

    if (variantType === null) {
      return;
    }

    // Find nodes whose variants array contains the target type
    cy.nodes("[!isGroup]")
      .filter((node) => {
        const variants = node.data("variants") as
          | { type: string }[]
          | undefined;
        return variants?.some((v) => v.type === variantType) ?? false;
      })
      .addClass("variant-highlight");
  }

  /**
   * Search nodes by screen name or path. Focuses/zooms to matching nodes.
   * Returns the number of matches found.
   */
  searchAndFocus(cy: Core, query: string): number {
    this.searchQuery.set(query);

    // Remove previous search highlight
    cy.nodes().removeClass("search-match");

    if (!query.trim()) {
      return 0;
    }

    const lowerQuery = query.toLowerCase();
    const matchingNodes = cy.nodes("[!isGroup]").filter((node) => {
      const label = (node.data("label") as string) ?? "";
      const path = (node.data("path") as string) ?? "";
      return (
        label.toLowerCase().includes(lowerQuery) ||
        path.toLowerCase().includes(lowerQuery)
      );
    });

    if (matchingNodes.length > 0) {
      matchingNodes.addClass("search-match");
      cy.animate({
        fit: { eles: matchingNodes, padding: 60 },
        duration: 400,
      } as cytoscape.AnimateOptions);
    }

    return matchingNodes.length;
  }

  // -----------------------------------------------------------------------
  // Public API — export operations
  // -----------------------------------------------------------------------

  /**
   * Export the current graph as a PNG image and trigger a download.
   * Uses `full: true` to capture the entire graph and `hide()/show()` to ensure
   * hidden elements are excluded from the export output.
   */
  exportPng(cy: Core, filename = "route-atlas-graph.png"): void {
    const pngData = cy.png({
      output: "blob",
      bg: "#ffffff",
      full: true,
      scale: 2,
    } as cytoscape.ExportBlobOptions);
    this.downloadBlob(pngData as Blob, filename);
  }

  /**
   * Export the current graph as an SVG vector and trigger a download.
   * Requires the cytoscape-svg extension. Falls back to PNG if unavailable.
   */
  exportSvg(cy: Core, filename = "route-atlas-graph.svg"): void {
    // cy.svg() is available when cytoscape-svg extension is registered.
    // Since Cytoscape core doesn't include svg() natively, we check
    // for its existence and fall back gracefully.
    const cyAny = cy as unknown as {
      svg?: (options?: Record<string, unknown>) => string;
    };
    if (typeof cyAny.svg === "function") {
      const svgContent = cyAny.svg({ full: true, bg: "#ffffff", scale: 2 });
      const blob = new Blob([svgContent], { type: "image/svg+xml" });
      this.downloadBlob(blob, filename);
    } else {
      // Fallback: use built-in png() and download as PNG instead
      this.exportPng(cy, filename.replace(/\.svg$/, ".png"));
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    // Clean up the object URL after a short delay
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
