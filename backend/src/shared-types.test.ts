import { describe, it, expect } from "vitest";
import type { AnalysisResult } from "@route-atlas/shared";

describe("Shared types", () => {
  it("should create a valid AnalysisResult", () => {
    const result: AnalysisResult = {
      framework: "angular",
      screens: [
        {
          id: "screen_home",
          path: "/",
          componentFile: "src/app/home/home.ts",
          label: "Home",
          description: "Landing page",
          variants: [
            {
              id: "variant_loading",
              label: "Loading",
              condition: "Data is being fetched",
              type: "loading",
            },
          ],
        },
      ],
      transitions: [
        {
          id: "transition_1",
          from: "screen_home",
          to: "screen_dashboard",
          trigger: "Navigation link click",
          method: "routerLink",
        },
      ],
    };

    expect(result.framework).toBe("angular");
    expect(result.screens).toHaveLength(1);
    expect(result.screens[0].variants).toHaveLength(1);
    expect(result.screens[0].variants[0].type).toBe("loading");
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0].condition).toBeUndefined();
  });

  it("should support optional condition on Transition", () => {
    const result: AnalysisResult = {
      framework: "next",
      screens: [],
      transitions: [
        {
          id: "transition_1",
          from: "screen_a",
          to: "screen_b",
          trigger: "Button click",
          method: "router.push",
          condition: "User is authenticated",
        },
      ],
    };

    expect(result.transitions[0].condition).toBe("User is authenticated");
  });
});
