/**
 * Graph Component
 *
 * Main graph visualization screen. Renders the analysis result as an
 * interactive directed graph using Cytoscape.js with dagre layout.
 *
 * Route: /graph/:jobId
 *
 * Reference: SPEC.md §7.2, §7.3
 */

import {
  Component,
  OnInit,
  OnDestroy,
  DestroyRef,
  inject,
  signal,
  ElementRef,
  viewChild,
  AfterViewInit,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatTooltipModule } from "@angular/material/tooltip";
import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import type { Core, EventObject, NodeSingular } from "cytoscape";
import type { AnalysisResult, Transition } from "@route-atlas/shared";
import { GraphService } from "./graph.service";
import { GraphFilterService } from "./graph-filter.service";
import { DetailPanelComponent } from "./detail-panel";
import type { SelectedNodeData } from "./detail-panel";
import { FilterPanelComponent } from "./filter-panel";
import { convertToCytoscapeElements } from "./graph-converter";

// Register the dagre layout extension once
try {
  cytoscape.use(dagre);
} catch {
  // Already registered — ignore double-registration error
}

@Component({
  selector: "app-graph",
  standalone: true,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    DetailPanelComponent,
    FilterPanelComponent,
  ],
  providers: [GraphFilterService],
  templateUrl: "./graph.html",
  styleUrl: "./graph.scss",
})
export class GraphComponent implements OnInit, AfterViewInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private graphService = inject(GraphService);
  private destroyRef = inject(DestroyRef);

  readonly cyContainer = viewChild<ElementRef<HTMLDivElement>>("cyContainer");

  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly emptyResult = signal(false);
  readonly selectedNode = signal<SelectedNodeData | null>(null);
  readonly filterPanelOpen = signal(false);

  /** Exposed as a signal so the filter panel can access the Cytoscape instance. */
  readonly cyInstance = signal<Core | null>(null);

  private analysisResult: AnalysisResult | null = null;

  /** Shorthand getter for internal use. */
  private get cy(): Core | null {
    return this.cyInstance();
  }

  ngOnInit(): void {
    const jobId = this.route.snapshot.paramMap.get("jobId");
    if (!jobId) {
      this.errorMessage.set("Job ID is not specified.");
      this.loading.set(false);
      return;
    }
    this.loadGraph(jobId);
  }

  ngAfterViewInit(): void {
    // Graph initialization happens in loadGraph after data arrives
  }

  ngOnDestroy(): void {
    this.cyInstance()?.destroy();
    this.cyInstance.set(null);
  }

  /** Navigate back to repos page. */
  goBack(): void {
    this.router.navigate(["/repos"]);
  }

  /** Close the detail panel. */
  closeDetailPanel(): void {
    this.selectedNode.set(null);
    // Deselect all nodes
    this.cyInstance()?.elements().unselect();
  }

  /** Toggle the filter/export panel. Closes detail panel when opening. */
  toggleFilterPanel(): void {
    this.filterPanelOpen.update((open) => {
      if (!open) {
        // Close detail panel when opening filter panel
        this.selectedNode.set(null);
      }
      return !open;
    });
  }

  /** Fit the graph to the viewport. */
  fitGraph(): void {
    this.cy?.fit(undefined, 40);
  }

  private loadGraph(jobId: string): void {
    this.graphService
      .fetchResult(jobId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.analysisResult = result;
          this.loading.set(false);
          if (result.screens.length === 0) {
            this.emptyResult.set(true);
            return;
          }
          // Schedule Cytoscape init after Angular renders the container
          setTimeout(() => this.initCytoscape(result), 0);
        },
        error: (err) => {
          const message =
            err?.error?.message ??
            err?.message ??
            "Failed to load analysis result.";
          this.errorMessage.set(message);
          this.loading.set(false);
        },
      });
  }

  private initCytoscape(result: AnalysisResult): void {
    const containerRef = this.cyContainer();
    if (!containerRef) {
      return;
    }
    const container = containerRef.nativeElement;
    const elements = convertToCytoscapeElements(result);

    // In test environments without canvas support, use headless renderer
    const testCanvas =
      typeof document !== "undefined" ? document.createElement("canvas") : null;
    const hasCanvas =
      testCanvas !== null &&
      typeof testCanvas.getContext === "function" &&
      testCanvas.getContext("2d") !== null;

    // Cytoscape style definitions — cast as cytoscape.StylesheetStyle[] to work
    // around @types/cytoscape being overly strict with padding string values.
    const graphStyle: cytoscape.StylesheetStyle[] = [
      // --- Compound / group nodes ---
      {
        selector: "node[?isGroup]",
        style: {
          shape: "round-rectangle",
          "background-color": "#e8eaf6",
          "background-opacity": 0.4,
          "border-color": "#5c6bc0",
          "border-width": 1,
          "border-style": "dashed",
          label: "data(label)",
          "text-valign": "top",
          "text-halign": "center",
          "font-size": "11px",
          color: "#5c6bc0",
          padding: "16px",
        } as cytoscape.Css.Node,
      },
      // --- Screen nodes ---
      {
        selector: "node[!isGroup]",
        style: {
          shape: "round-rectangle",
          width: "label",
          height: "label",
          "background-color": "#1e88e5",
          color: "#ffffff",
          label: "data(label)",
          "text-valign": "center",
          "text-halign": "center",
          "font-size": "13px",
          "font-weight": "bold",
          padding: "12px",
          "text-wrap": "wrap",
          "text-max-width": "160px",
          "border-width": 0,
        } as cytoscape.Css.Node,
      },
      // --- Nodes with variants: show badge via border ---
      {
        selector: "node[variantCount > 0][!isGroup]",
        style: {
          "border-width": 3,
          "border-color": "#ff9800",
        },
      },
      // --- Selected node ---
      {
        selector: "node:selected[!isGroup]",
        style: {
          "background-color": "#0d47a1",
          "border-width": 3,
          "border-color": "#fdd835",
        },
      },
      // --- Edge base style (Link: solid) ---
      {
        selector: "edge",
        style: {
          width: 2,
          "line-color": "#90a4ae",
          "target-arrow-color": "#90a4ae",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          label: "data(label)",
          "font-size": "10px",
          color: "#546e7a",
          "text-background-color": "#ffffff",
          "text-background-opacity": 0.8,
          "text-background-padding": "2px",
        } as cytoscape.Css.Edge,
      },
      // --- Programmatic navigation: dashed ---
      {
        selector: "edge[method = 'programmatic']",
        style: {
          "line-style": "dashed",
          "line-color": "#7e57c2",
          "target-arrow-color": "#7e57c2",
        },
      },
      // --- Redirect: dotted ---
      {
        selector: "edge[method = 'redirect']",
        style: {
          "line-style": "dotted",
          "line-color": "#ef5350",
          "target-arrow-color": "#ef5350",
        },
      },
      // --- Conditional transition: dashed ---
      {
        selector: "edge[condition]",
        style: {
          "line-style": "dashed",
        },
      },
      // --- Variant highlight class ---
      {
        selector: "node.variant-highlight",
        style: {
          "background-color": "#f57c00",
          "border-width": 4,
          "border-color": "#e65100",
          color: "#ffffff",
        },
      },
      // --- Search match class ---
      {
        selector: "node.search-match",
        style: {
          "background-color": "#43a047",
          "border-width": 4,
          "border-color": "#1b5e20",
          color: "#ffffff",
        },
      },
    ];

    const cyInstance = cytoscape({
      container: hasCanvas ? container : undefined,
      headless: !hasCanvas,
      elements,
      style: graphStyle,
      layout: {
        name: "dagre",
        rankDir: "TB",
        nodeSep: 60,
        rankSep: 80,
        padding: 40,
      } as cytoscape.LayoutOptions,
      // Enable zoom, pan, and node dragging
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
    });

    this.cyInstance.set(cyInstance);

    // Node click handler
    cyInstance.on("tap", "node[!isGroup]", (event: EventObject) => {
      const node = event.target as NodeSingular;
      this.onNodeClick(node);
    });

    // Click on background to close detail panel
    cyInstance.on("tap", (event: EventObject) => {
      if (event.target === cyInstance) {
        this.closeDetailPanel();
      }
    });
  }

  private onNodeClick(node: NodeSingular): void {
    // Close filter panel when opening detail panel
    this.filterPanelOpen.set(false);

    const data = node.data();
    const transitions = this.analysisResult?.transitions ?? [];
    const outgoing = transitions.filter(
      (t: Transition) => t.from === data["id"],
    );

    this.selectedNode.set({
      id: data["id"] as string,
      label: data["label"] as string,
      path: data["path"] as string,
      componentFile: data["componentFile"] as string,
      description: data["description"] as string,
      variants: data["variants"] ?? [],
      outgoingTransitions: outgoing,
    });
  }
}
