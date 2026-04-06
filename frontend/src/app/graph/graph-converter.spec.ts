import {
  convertToCytoscapeElements,
  classifyMethod,
  deriveParentPath,
} from "./graph-converter";
import type { AnalysisResult } from "@route-atlas/shared";

describe("graph-converter", () => {
  describe("classifyMethod", () => {
    it("should classify Link/a/routerLink as link", () => {
      expect(classifyMethod("Link")).toBe("link");
      expect(classifyMethod("<a>")).toBe("link");
      expect(classifyMethod("routerLink")).toBe("link");
    });

    it("should classify router.push/navigate as programmatic", () => {
      expect(classifyMethod("router.push")).toBe("programmatic");
      expect(classifyMethod("router.navigate")).toBe("programmatic");
      expect(classifyMethod("useNavigate")).toBe("programmatic");
      expect(classifyMethod("programmatic")).toBe("programmatic");
    });

    it("should classify redirect/window.location as redirect", () => {
      expect(classifyMethod("redirect")).toBe("redirect");
      expect(classifyMethod("redirect()")).toBe("redirect");
      expect(classifyMethod("window.location")).toBe("redirect");
    });

    it("should default to link for unknown methods", () => {
      expect(classifyMethod("unknown")).toBe("link");
      expect(classifyMethod("")).toBe("link");
    });
  });

  describe("deriveParentPath", () => {
    it("should return null for root path", () => {
      expect(deriveParentPath("/")).toBeNull();
    });

    it("should return null for top-level paths", () => {
      expect(deriveParentPath("/login")).toBeNull();
      expect(deriveParentPath("/repos")).toBeNull();
    });

    it("should return parent for nested paths", () => {
      expect(deriveParentPath("/dashboard/settings")).toBe("/dashboard");
      expect(deriveParentPath("/admin/users/list")).toBe("/admin/users");
    });

    it("should handle trailing slashes", () => {
      expect(deriveParentPath("/dashboard/settings/")).toBe("/dashboard");
    });
  });

  describe("convertToCytoscapeElements", () => {
    const sampleResult: AnalysisResult = {
      framework: "next",
      screens: [
        {
          id: "screen_home",
          path: "/",
          componentFile: "app/page.tsx",
          label: "Home",
          description: "Home page",
          variants: [],
        },
        {
          id: "screen_dashboard",
          path: "/dashboard",
          componentFile: "app/dashboard/page.tsx",
          label: "Dashboard",
          description: "Dashboard overview",
          variants: [
            {
              id: "v1",
              label: "Loading",
              condition: "Data is being fetched",
              type: "loading",
            },
            {
              id: "v2",
              label: "Error",
              condition: "API request fails",
              type: "error",
            },
          ],
        },
        {
          id: "screen_settings",
          path: "/dashboard/settings",
          componentFile: "app/dashboard/settings/page.tsx",
          label: "Settings",
          description: "User settings",
          variants: [],
        },
      ],
      transitions: [
        {
          id: "t1",
          from: "screen_home",
          to: "screen_dashboard",
          trigger: "Click dashboard link",
          method: "Link",
        },
        {
          id: "t2",
          from: "screen_dashboard",
          to: "screen_settings",
          trigger: "Click settings",
          method: "router.push",
          condition: "User is admin",
        },
        {
          id: "t3",
          from: "screen_settings",
          to: "screen_home",
          trigger: "Logout",
          method: "redirect",
        },
      ],
    };

    it("should create nodes for all screens", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      const screenNodes = elements.filter((e) =>
        e.data["id"]?.toString().startsWith("screen_"),
      );
      expect(screenNodes.length).toBe(3);
    });

    it("should include label and path in node data", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      const homeNode = elements.find((e) => e.data["id"] === "screen_home");
      expect(homeNode).toBeDefined();
      expect(homeNode!.data["label"]).toBe("Home");
      expect(homeNode!.data["path"]).toBe("/");
    });

    it("should include variant count in node data", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      const dashNode = elements.find(
        (e) => e.data["id"] === "screen_dashboard",
      );
      expect(dashNode!.data["variantCount"]).toBe(2);
    });

    it("should create edges for all transitions", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      const edges = elements.filter(
        (e) => e.data["source"] && e.data["target"],
      );
      expect(edges.length).toBe(3);
    });

    it("should classify edge methods correctly", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      const edges = elements.filter(
        (e) => e.data["source"] && e.data["target"],
      );

      const linkEdge = edges.find((e) => e.data["id"] === "t1");
      expect(linkEdge!.data["method"]).toBe("link");

      const programmaticEdge = edges.find((e) => e.data["id"] === "t2");
      expect(programmaticEdge!.data["method"]).toBe("programmatic");

      const redirectEdge = edges.find((e) => e.data["id"] === "t3");
      expect(redirectEdge!.data["method"]).toBe("redirect");
    });

    it("should include condition on conditional edges", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      const conditionalEdge = elements.find((e) => e.data["id"] === "t2");
      expect(conditionalEdge!.data["condition"]).toBe("User is admin");
    });

    it("should set null condition for non-conditional edges", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      const linkEdge = elements.find((e) => e.data["id"] === "t1");
      expect(linkEdge!.data["condition"]).toBeNull();
    });

    it("should create parent group nodes for nested routes", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      // /dashboard/settings should have a parent group for /dashboard
      // Since /dashboard is an existing screen, a group::/dashboard node should be created
      const settingsNode = elements.find(
        (e) => e.data["id"] === "screen_settings",
      );
      expect(settingsNode!.data["parent"]).toBe("group:/dashboard");

      const groupNode = elements.find(
        (e) => e.data["id"] === "group:/dashboard",
      );
      expect(groupNode).toBeDefined();
      expect(groupNode!.data["isGroup"]).toBe(true);
    });

    it("should handle empty analysis results", () => {
      const emptyResult: AnalysisResult = {
        framework: "next",
        screens: [],
        transitions: [],
      };
      const elements = convertToCytoscapeElements(emptyResult);
      expect(elements.length).toBe(0);
    });

    it("should include trigger as edge label", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      const edge = elements.find((e) => e.data["id"] === "t1");
      expect(edge!.data["label"]).toBe("Click dashboard link");
    });

    it("should store variants array in node data", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      const dashNode = elements.find(
        (e) => e.data["id"] === "screen_dashboard",
      );
      const variants = dashNode!.data["variants"] as unknown[];
      expect(variants.length).toBe(2);
    });

    it("should not create parent group for top-level screens", () => {
      const elements = convertToCytoscapeElements(sampleResult);
      const homeNode = elements.find((e) => e.data["id"] === "screen_home");
      expect(homeNode!.data["parent"]).toBeUndefined();
    });
  });
});
