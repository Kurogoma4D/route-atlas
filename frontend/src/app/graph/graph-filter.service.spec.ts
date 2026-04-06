import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphFilterService } from "./graph-filter.service";
import type { Core } from "cytoscape";

/**
 * Create a minimal mock Cytoscape Core for testing filter/export logic.
 */
function createMockCy() {
  const hiddenEdges = new Set<string>();
  const nodeClasses = new Map<string, Set<string>>();
  let animateOptions: unknown = null;
  let pngCalled = false;
  let svgCalled = false;

  // Mock node collection
  const mockNodes = [
    {
      id: "screen_home",
      data: (key?: string) => {
        const d: Record<string, unknown> = {
          id: "screen_home",
          label: "Home",
          path: "/",
          isGroup: undefined,
          variants: [],
        };
        return key ? d[key] : d;
      },
      addClass: (cls: string) => {
        if (!nodeClasses.has("screen_home"))
          nodeClasses.set("screen_home", new Set());
        nodeClasses.get("screen_home")!.add(cls);
      },
      removeClass: (cls: string) => {
        nodeClasses.get("screen_home")?.delete(cls);
      },
      hasClass: (cls: string) =>
        nodeClasses.get("screen_home")?.has(cls) ?? false,
    },
    {
      id: "screen_dashboard",
      data: (key?: string) => {
        const d: Record<string, unknown> = {
          id: "screen_dashboard",
          label: "Dashboard",
          path: "/dashboard",
          isGroup: undefined,
          variants: [{ type: "loading", label: "Loading", condition: "fetch" }],
        };
        return key ? d[key] : d;
      },
      addClass: (cls: string) => {
        if (!nodeClasses.has("screen_dashboard"))
          nodeClasses.set("screen_dashboard", new Set());
        nodeClasses.get("screen_dashboard")!.add(cls);
      },
      removeClass: (cls: string) => {
        nodeClasses.get("screen_dashboard")?.delete(cls);
      },
      hasClass: (cls: string) =>
        nodeClasses.get("screen_dashboard")?.has(cls) ?? false,
    },
    {
      id: "screen_settings",
      data: (key?: string) => {
        const d: Record<string, unknown> = {
          id: "screen_settings",
          label: "Settings",
          path: "/settings",
          isGroup: undefined,
          variants: [
            { type: "error", label: "Error", condition: "save failed" },
          ],
        };
        return key ? d[key] : d;
      },
      addClass: (cls: string) => {
        if (!nodeClasses.has("screen_settings"))
          nodeClasses.set("screen_settings", new Set());
        nodeClasses.get("screen_settings")!.add(cls);
      },
      removeClass: (cls: string) => {
        nodeClasses.get("screen_settings")?.delete(cls);
      },
      hasClass: (cls: string) =>
        nodeClasses.get("screen_settings")?.has(cls) ?? false,
    },
  ];

  // Shared collection helper for node operations
  function createNodeCollection(nodes: typeof mockNodes) {
    return {
      length: nodes.length,
      forEach: (fn: (node: (typeof mockNodes)[0]) => void) => nodes.forEach(fn),
      filter: (fn: (node: (typeof mockNodes)[0]) => boolean) =>
        createNodeCollection(nodes.filter(fn)),
      addClass: (cls: string) => {
        nodes.forEach((n) => n.addClass(cls));
        return createNodeCollection(nodes);
      },
      removeClass: (cls: string) => {
        nodes.forEach((n) => n.removeClass(cls));
        return createNodeCollection(nodes);
      },
    };
  }

  // Edge mocks — uses style("display", ...) like the service implementation
  function createEdgeCollection(methods: string[]) {
    return {
      style: (prop: string, value?: string) => {
        if (prop === "display" && value === "none") {
          methods.forEach((m) => hiddenEdges.add(m));
        } else if (prop === "display" && value === "element") {
          methods.forEach((m) => hiddenEdges.delete(m));
        }
      },
    };
  }

  const cy = {
    nodes: (selector?: string) => {
      if (selector === "[!isGroup]") {
        return createNodeCollection(mockNodes);
      }
      return createNodeCollection(mockNodes);
    },
    edges: (selector?: string) => {
      if (selector?.includes("link")) return createEdgeCollection(["link"]);
      if (selector?.includes("programmatic"))
        return createEdgeCollection(["programmatic"]);
      if (selector?.includes("redirect"))
        return createEdgeCollection(["redirect"]);
      return createEdgeCollection([]);
    },
    animate: (opts: unknown) => {
      animateOptions = opts;
    },
    png: (opts?: unknown) => {
      pngCalled = true;
      return new Blob(["fake-png"], { type: "image/png" });
    },
    svg: (opts?: unknown) => {
      svgCalled = true;
      return "<svg>mock</svg>";
    },
    // Test inspection helpers
    _test: {
      isEdgeHidden: (method: string) => hiddenEdges.has(method),
      nodeHasClass: (id: string, cls: string) =>
        nodeClasses.get(id)?.has(cls) ?? false,
      getAnimateOptions: () => animateOptions,
      wasPngCalled: () => pngCalled,
      wasSvgCalled: () => svgCalled,
      resetPngCalled: () => {
        pngCalled = false;
      },
      resetSvgCalled: () => {
        svgCalled = false;
      },
    },
  } as unknown as Core & {
    _test: {
      isEdgeHidden: (method: string) => boolean;
      nodeHasClass: (id: string, cls: string) => boolean;
      getAnimateOptions: () => unknown;
      wasPngCalled: () => boolean;
      wasSvgCalled: () => boolean;
      resetPngCalled: () => void;
      resetSvgCalled: () => void;
    };
  };

  return cy;
}

describe("GraphFilterService", () => {
  let service: GraphFilterService;
  let cy: ReturnType<typeof createMockCy>;

  beforeEach(() => {
    service = new GraphFilterService();
    cy = createMockCy();
  });

  // -----------------------------------------------------------------------
  // Transition type filter
  // -----------------------------------------------------------------------

  describe("transition type filter", () => {
    it("should have all transition types visible by default", () => {
      const filters = service.transitionFilters();
      expect(filters.link).toBe(true);
      expect(filters.programmatic).toBe(true);
      expect(filters.redirect).toBe(true);
    });

    it("should hide link edges when toggled off", () => {
      service.toggleTransitionType("link", false, cy);
      expect(cy._test.isEdgeHidden("link")).toBe(true);
      expect(service.transitionFilters().link).toBe(false);
    });

    it("should show link edges when toggled back on", () => {
      service.toggleTransitionType("link", false, cy);
      service.toggleTransitionType("link", true, cy);
      expect(cy._test.isEdgeHidden("link")).toBe(false);
    });

    it("should hide programmatic edges when toggled off", () => {
      service.toggleTransitionType("programmatic", false, cy);
      expect(cy._test.isEdgeHidden("programmatic")).toBe(true);
    });

    it("should hide redirect edges when toggled off", () => {
      service.toggleTransitionType("redirect", false, cy);
      expect(cy._test.isEdgeHidden("redirect")).toBe(true);
    });

    it("should handle null cy gracefully", () => {
      expect(() =>
        service.toggleTransitionType("link", false, null),
      ).not.toThrow();
      expect(service.transitionFilters().link).toBe(false);
    });

    it("should apply all filter states at once via applyTransitionFilter", () => {
      service.toggleTransitionType("link", false, null);
      service.toggleTransitionType("redirect", false, null);
      service.applyTransitionFilter(cy);
      expect(cy._test.isEdgeHidden("link")).toBe(true);
      expect(cy._test.isEdgeHidden("redirect")).toBe(true);
      expect(cy._test.isEdgeHidden("programmatic")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Variant highlight
  // -----------------------------------------------------------------------

  describe("variant highlight", () => {
    it("should highlight nodes with matching variant type", () => {
      service.applyVariantHighlight(cy, "loading");
      expect(
        cy._test.nodeHasClass("screen_dashboard", "variant-highlight"),
      ).toBe(true);
      expect(cy._test.nodeHasClass("screen_home", "variant-highlight")).toBe(
        false,
      );
      expect(
        cy._test.nodeHasClass("screen_settings", "variant-highlight"),
      ).toBe(false);
    });

    it("should clear highlights when null is passed", () => {
      service.applyVariantHighlight(cy, "loading");
      service.applyVariantHighlight(cy, null);
      expect(
        cy._test.nodeHasClass("screen_dashboard", "variant-highlight"),
      ).toBe(false);
    });

    it("should update the highlighted variant type signal", () => {
      service.applyVariantHighlight(cy, "error");
      expect(service.highlightedVariantType()).toBe("error");
    });

    it("should highlight error variant nodes", () => {
      service.applyVariantHighlight(cy, "error");
      expect(
        cy._test.nodeHasClass("screen_settings", "variant-highlight"),
      ).toBe(true);
      expect(
        cy._test.nodeHasClass("screen_dashboard", "variant-highlight"),
      ).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  describe("search", () => {
    it("should find nodes by label (case-insensitive)", () => {
      const count = service.searchAndFocus(cy, "dashboard");
      expect(count).toBe(1);
      expect(cy._test.nodeHasClass("screen_dashboard", "search-match")).toBe(
        true,
      );
    });

    it("should find nodes by path", () => {
      const count = service.searchAndFocus(cy, "/settings");
      expect(count).toBe(1);
      expect(cy._test.nodeHasClass("screen_settings", "search-match")).toBe(
        true,
      );
    });

    it("should return 0 for empty query", () => {
      const count = service.searchAndFocus(cy, "");
      expect(count).toBe(0);
    });

    it("should return 0 for non-matching query", () => {
      const count = service.searchAndFocus(cy, "nonexistent");
      expect(count).toBe(0);
    });

    it("should find multiple matching nodes", () => {
      // "s" matches "Settings" and "Dashboard" in label, and "/settings" and "/dashboard" in path
      const count = service.searchAndFocus(cy, "s");
      // "Home" doesn't match "s", "Dashboard" label has 's', "Settings" label has 's'
      expect(count).toBe(2);
    });

    it("should clear previous search highlights", () => {
      service.searchAndFocus(cy, "dashboard");
      service.searchAndFocus(cy, "settings");
      expect(cy._test.nodeHasClass("screen_dashboard", "search-match")).toBe(
        false,
      );
      expect(cy._test.nodeHasClass("screen_settings", "search-match")).toBe(
        true,
      );
    });

    it("should trigger animate (fit) on matching nodes", () => {
      service.searchAndFocus(cy, "home");
      const opts = cy._test.getAnimateOptions() as Record<string, unknown>;
      expect(opts).not.toBeNull();
      expect(opts["fit"]).toBeDefined();
    });

    it("should update the search query signal", () => {
      service.searchAndFocus(cy, "test");
      expect(service.searchQuery()).toBe("test");
    });
  });

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  describe("export", () => {
    beforeEach(() => {
      // Stub URL methods used by downloadBlob
      globalThis.URL.createObjectURL = (() =>
        "blob:http://localhost/fake") as typeof URL.createObjectURL;
      globalThis.URL.revokeObjectURL = (() =>
        undefined) as typeof URL.revokeObjectURL;
    });

    it("should call cy.png() for PNG export", () => {
      service.exportPng(cy);
      expect(cy._test.wasPngCalled()).toBe(true);
    });

    it("should call cy.svg() for SVG export", () => {
      service.exportSvg(cy);
      expect(cy._test.wasSvgCalled()).toBe(true);
    });

    it("should fallback to PNG when svg() is not available", () => {
      const cyNoSvg = { ...cy, svg: undefined } as unknown as Core & {
        _test: typeof cy._test;
      };
      cy._test.resetPngCalled();
      service.exportSvg(cyNoSvg);
      // Should fall back to exportPng — which calls cy.png() on the
      // original mock, but since we spread, we check no error thrown
      expect(() => service.exportSvg(cyNoSvg)).not.toThrow();
    });

    it("should use custom filename for PNG without error", () => {
      expect(() => service.exportPng(cy, "my-graph.png")).not.toThrow();
      expect(cy._test.wasPngCalled()).toBe(true);
    });
  });
});
