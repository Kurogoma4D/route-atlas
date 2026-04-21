import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AnalysisPipeline,
  isSupportedModel,
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
} from "./analysis-pipeline.js";
import type { LLMAdapter, ChatCompletionOptions } from "./copilot-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock adapter whose chatCompletion returns queued responses. */
function createMockAdapter(
  responses: string[],
): LLMAdapter & { calls: ChatCompletionOptions[] } {
  const calls: ChatCompletionOptions[] = [];
  let callIndex = 0;

  return {
    calls,
    chatCompletion: vi.fn(async (options: ChatCompletionOptions) => {
      calls.push(options);
      const content = responses[callIndex] ?? "[]";
      callIndex++;
      return { content };
    }),
    dispose: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_ROUTING_FILE = {
  path: "src/app/routes.ts",
  content: `
import { Route } from '@angular/router';
export const routes: Route[] = [
  { path: '', component: HomeComponent },
  { path: 'dashboard', component: DashboardComponent },
  { path: 'login', component: LoginComponent },
];
`,
};

const SAMPLE_COMPONENT_FILES = [
  {
    path: "src/app/home.component.ts",
    content: `
@Component({ template: '<div *ngIf="loading">Loading...</div><div *ngIf="!loading">Home</div>' })
export class HomeComponent {
  loading = true;
}
`,
  },
  {
    path: "src/app/dashboard.component.ts",
    content: `
@Component({ template: '<div *ngIf="error">Error!</div><div>Dashboard</div>' })
export class DashboardComponent {
  error = false;
}
`,
  },
  {
    path: "src/app/login.component.ts",
    content: `
@Component({ template: '<form (submit)="onLogin()">Login</form>' })
export class LoginComponent {
  onLogin() { this.router.navigate(['/dashboard']); }
}
`,
  },
];

// LLM mock responses
const TURN1_RESPONSE = JSON.stringify([
  {
    id: "screen_home",
    path: "/",
    componentFile: "src/app/home.component.ts",
    label: "Home",
    description: "Home page",
  },
  {
    id: "screen_dashboard",
    path: "/dashboard",
    componentFile: "src/app/dashboard.component.ts",
    label: "Dashboard",
    description: "Dashboard page",
  },
  {
    id: "screen_login",
    path: "/login",
    componentFile: "src/app/login.component.ts",
    label: "Login",
    description: "Login page",
  },
]);

const TURN2_HOME_RESPONSE = JSON.stringify([
  {
    id: "variant_loading_home",
    label: "Loading state",
    condition: "When loading is true",
    type: "loading",
  },
]);

const TURN2_DASHBOARD_RESPONSE = JSON.stringify([
  {
    id: "variant_error_dashboard",
    label: "Error state",
    condition: "When error is true",
    type: "error",
  },
]);

const TURN2_LOGIN_RESPONSE = JSON.stringify([]);

const TURN3_RESPONSE = JSON.stringify([
  {
    id: "transition_login_to_dashboard",
    from: "screen_login",
    to: "screen_dashboard",
    trigger: "Form submission",
    method: "router.navigate",
  },
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnalysisPipeline", () => {
  let adapter: ReturnType<typeof createMockAdapter>;
  let pipeline: AnalysisPipeline;

  beforeEach(() => {
    adapter = createMockAdapter([
      TURN1_RESPONSE,
      TURN2_HOME_RESPONSE,
      TURN2_DASHBOARD_RESPONSE,
      TURN2_LOGIN_RESPONSE,
      TURN3_RESPONSE,
    ]);
    pipeline = new AnalysisPipeline(adapter);
  });

  it("runs all three turns and returns a valid AnalysisResult", async () => {
    const result = await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
    });

    expect(result.framework).toBe("angular");
    expect(result.screens).toHaveLength(3);
    expect(result.transitions).toHaveLength(1);
  });

  it("Turn 1 extracts all screens", async () => {
    const result = await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
    });

    const ids = result.screens.map((s) => s.id);
    expect(ids).toContain("screen_home");
    expect(ids).toContain("screen_dashboard");
    expect(ids).toContain("screen_login");
  });

  it("Turn 2 attaches variants to the correct screens", async () => {
    const result = await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
    });

    const home = result.screens.find((s) => s.id === "screen_home")!;
    expect(home.variants).toHaveLength(1);
    expect(home.variants[0]!.type).toBe("loading");

    const dashboard = result.screens.find((s) => s.id === "screen_dashboard")!;
    expect(dashboard.variants).toHaveLength(1);
    expect(dashboard.variants[0]!.type).toBe("error");

    const login = result.screens.find((s) => s.id === "screen_login")!;
    expect(login.variants).toHaveLength(0);
  });

  it("Turn 3 extracts transitions", async () => {
    const result = await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
    });

    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toMatchObject({
      from: "screen_login",
      to: "screen_dashboard",
      method: "router.navigate",
    });
  });

  it("calls onProgress callback between turns", async () => {
    const stages: string[] = [];
    await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
      onProgress: (stage) => {
        stages.push(stage);
      },
    });

    expect(stages).toEqual(["analyzing_variants", "analyzing_transitions"]);
  });

  it("uses the default model when none specified", async () => {
    await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
    });

    // All calls should use the default model
    for (const call of adapter.calls) {
      expect(call.model).toBe(DEFAULT_MODEL);
    }
  });

  it("respects a custom model parameter", async () => {
    await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
      model: "claude-sonnet-4",
    });

    for (const call of adapter.calls) {
      expect(call.model).toBe("claude-sonnet-4");
    }
  });

  it("handles markdown-fenced JSON responses", async () => {
    const fencedAdapter = createMockAdapter([
      "```json\n" + TURN1_RESPONSE + "\n```",
      "```\n" + TURN2_HOME_RESPONSE + "\n```",
      TURN2_DASHBOARD_RESPONSE,
      TURN2_LOGIN_RESPONSE,
      TURN3_RESPONSE,
    ]);
    const fencedPipeline = new AnalysisPipeline(fencedAdapter);

    const result = await fencedPipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
    });

    expect(result.screens).toHaveLength(3);
  });

  it("assigns empty variants when component source is not found", async () => {
    const adapterWithMissing = createMockAdapter([
      JSON.stringify([
        {
          id: "screen_missing",
          path: "/missing",
          componentFile: "src/app/does-not-exist.ts",
          label: "Missing",
          description: "Component file not in input",
        },
      ]),
      // No Turn 2 call for this screen since source is missing
      JSON.stringify([]), // Turn 3
    ]);
    const missingPipeline = new AnalysisPipeline(adapterWithMissing);

    const result = await missingPipeline.run({
      framework: "react-router",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: [], // no component files provided
    });

    expect(result.screens[0]!.variants).toEqual([]);
  });

  it("throws when LLM returns non-JSON content", async () => {
    const badAdapter = createMockAdapter(["This is not JSON at all, sorry!"]);
    const badPipeline = new AnalysisPipeline(badAdapter);

    await expect(
      badPipeline.run({
        framework: "angular",
        routingFiles: [SAMPLE_ROUTING_FILE],
        componentFiles: SAMPLE_COMPONENT_FILES,
      }),
    ).rejects.toThrow(); // SyntaxError from JSON.parse
  });

  it("throws when LLM returns valid JSON but wrong shape (object instead of array)", async () => {
    const badAdapter = createMockAdapter([JSON.stringify({ not: "an array" })]);
    const badPipeline = new AnalysisPipeline(badAdapter);

    await expect(
      badPipeline.run({
        framework: "angular",
        routingFiles: [SAMPLE_ROUTING_FILE],
        componentFiles: SAMPLE_COMPONENT_FILES,
      }),
    ).rejects.toThrow("failed runtime validation");
  });

  it("propagates LLM errors", async () => {
    const errorAdapter: LLMAdapter = {
      chatCompletion: vi
        .fn()
        .mockRejectedValue(new Error("Copilot API unavailable")),
      dispose: vi.fn(),
    };
    const errorPipeline = new AnalysisPipeline(errorAdapter);

    await expect(
      errorPipeline.run({
        framework: "angular",
        routingFiles: [SAMPLE_ROUTING_FILE],
        componentFiles: SAMPLE_COMPONENT_FILES,
      }),
    ).rejects.toThrow("Copilot API unavailable");
  });
});

// ---------------------------------------------------------------------------
// Model selection helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool-assisted pipeline
// ---------------------------------------------------------------------------

describe("AnalysisPipeline with customTools", () => {
  const fakeTool = {
    name: "readFile",
    description: "fake",
    handler: () => "contents",
  };

  it("passes tools through to the adapter on Turn 2 and Turn 3", async () => {
    const adapter = createMockAdapter([
      TURN1_RESPONSE,
      TURN2_HOME_RESPONSE,
      TURN2_DASHBOARD_RESPONSE,
      TURN2_LOGIN_RESPONSE,
      TURN3_RESPONSE,
    ]);
    const pipeline = new AnalysisPipeline(adapter);

    await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      candidateComponentPaths: SAMPLE_COMPONENT_FILES.map((f) => f.path),
      customTools: [fakeTool],
    });

    // First call is Turn 1 — no tools attached.
    expect(adapter.calls[0]!.tools).toBeUndefined();
    // Turn 2 calls (one per screen) should carry the tool set.
    for (let i = 1; i <= 3; i++) {
      expect(adapter.calls[i]!.tools).toEqual([fakeTool]);
    }
    // Turn 3 should also carry the tool set.
    expect(adapter.calls[4]!.tools).toEqual([fakeTool]);

    // System prompt should be the tools-specific variant.
    expect(adapter.calls[0]!.messages[0]!.content).toContain("readFile(path)");
  });

  it("omits the full source from Turn 2 / Turn 3 prompts when tools are in use", async () => {
    const adapter = createMockAdapter([
      TURN1_RESPONSE,
      TURN2_HOME_RESPONSE,
      TURN2_DASHBOARD_RESPONSE,
      TURN2_LOGIN_RESPONSE,
      TURN3_RESPONSE,
    ]);
    const pipeline = new AnalysisPipeline(adapter);

    await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      candidateComponentPaths: SAMPLE_COMPONENT_FILES.map((f) => f.path),
      customTools: [fakeTool],
    });

    // The raw component contents should NOT appear verbatim in Turn 2 / Turn 3
    // prompts — the model is expected to fetch them via tools.
    const turn2Prompts = adapter.calls
      .slice(1, 4)
      .map((c) => c.messages[c.messages.length - 1]!.content);
    for (const prompt of turn2Prompts) {
      expect(prompt).not.toContain("*ngIf=\"loading\"");
      expect(prompt).toContain("readFile");
    }

    const turn3Prompt =
      adapter.calls[4]!.messages[adapter.calls[4]!.messages.length - 1]!
        .content;
    expect(turn3Prompt).not.toContain("router.navigate(['/dashboard'])");
    expect(turn3Prompt).toContain("readFile");
  });

  it("falls back to the legacy embed-contents flow when no tools are provided", async () => {
    const adapter = createMockAdapter([
      TURN1_RESPONSE,
      TURN2_HOME_RESPONSE,
      TURN2_DASHBOARD_RESPONSE,
      TURN2_LOGIN_RESPONSE,
      TURN3_RESPONSE,
    ]);
    const pipeline = new AnalysisPipeline(adapter);

    await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
    });

    for (const call of adapter.calls) {
      expect(call.tools).toBeUndefined();
    }
  });

  it("treats customTools: [] the same as no tools (legacy embed flow)", async () => {
    const adapter = createMockAdapter([
      TURN1_RESPONSE,
      TURN2_HOME_RESPONSE,
      TURN2_DASHBOARD_RESPONSE,
      TURN2_LOGIN_RESPONSE,
      TURN3_RESPONSE,
    ]);
    const pipeline = new AnalysisPipeline(adapter);

    await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
      customTools: [],
    });

    // Empty array → useTools is false → no tools on any call.
    for (const call of adapter.calls) {
      expect(call.tools).toBeUndefined();
    }
    // System prompt should be the plain (non-tools) variant.
    expect(adapter.calls[0]!.messages[0]!.content).not.toContain("readFile(path)");
  });

  it("falls back to componentFiles paths when candidateComponentPaths is omitted", async () => {
    const adapter = createMockAdapter([
      TURN1_RESPONSE,
      TURN2_HOME_RESPONSE,
      TURN2_DASHBOARD_RESPONSE,
      TURN2_LOGIN_RESPONSE,
      TURN3_RESPONSE,
    ]);
    const pipeline = new AnalysisPipeline(adapter);

    await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: SAMPLE_COMPONENT_FILES,
      customTools: [fakeTool],
      // candidateComponentPaths is intentionally omitted
    });

    // Turn 3 prompt should contain file paths derived from componentFiles.
    const turn3Prompt =
      adapter.calls[4]!.messages[adapter.calls[4]!.messages.length - 1]!.content;
    for (const f of SAMPLE_COMPONENT_FILES) {
      expect(turn3Prompt).toContain(f.path);
    }
  });
});

describe("isSupportedModel", () => {
  it("accepts all supported models", () => {
    for (const model of SUPPORTED_MODELS) {
      expect(isSupportedModel(model)).toBe(true);
    }
  });

  it("rejects unsupported model names", () => {
    expect(isSupportedModel("gpt-3.5-turbo")).toBe(false);
    expect(isSupportedModel("")).toBe(false);
  });
});
