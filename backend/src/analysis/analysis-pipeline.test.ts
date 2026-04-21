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

describe("AnalysisPipeline tool-driven mode", () => {
  const TREE = [
    {
      path: "src/app/home.component.ts",
      mode: "100644",
      type: "blob" as const,
      sha: "sha_home",
      size: 100,
      url: "u",
    },
    {
      path: "src/app/dashboard.component.ts",
      mode: "100644",
      type: "blob" as const,
      sha: "sha_dash",
      size: 100,
      url: "u",
    },
    {
      path: "src/app/login.component.ts",
      mode: "100644",
      type: "blob" as const,
      sha: "sha_login",
      size: 100,
      url: "u",
    },
  ];

  it("passes file-exploration tools to the adapter on every turn", async () => {
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
      fileToolContext: {
        owner: "o",
        repo: "r",
        branch: "main",
        token: "t",
        fileTree: TREE,
      },
    });

    expect(adapter.calls.length).toBeGreaterThan(0);
    for (const call of adapter.calls) {
      expect(call.tools).toBeDefined();
      const toolNames = call.tools!.map((t) => t.name);
      expect(toolNames).toEqual(["readFile", "searchFiles", "grepFiles"]);
    }
  });

  it("uses the tool-driven system prompt", async () => {
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
      fileToolContext: {
        owner: "o",
        repo: "r",
        branch: "main",
        token: "t",
        fileTree: TREE,
      },
    });

    const systemMsg = adapter.calls[0].messages.find(
      (m) => m.role === "system",
    )!;
    expect(systemMsg.content).toContain("readFile");
    expect(systemMsg.content).toContain("searchFiles");
    expect(systemMsg.content).toContain("grepFiles");
  });

  it("does NOT embed full file contents in Turn 1 prompt (tool mode)", async () => {
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
      fileToolContext: {
        owner: "o",
        repo: "r",
        branch: "main",
        token: "t",
        fileTree: TREE,
      },
    });

    const turn1Prompt = adapter.calls[0].messages.find(
      (m) => m.role === "user",
    )!.content;
    // Path is listed
    expect(turn1Prompt).toContain("src/app/routes.ts");
    // But the file's actual content is NOT embedded
    expect(turn1Prompt).not.toContain("HomeComponent");
    expect(turn1Prompt).not.toContain("DashboardComponent");
  });

  it("omits tools when fileToolContext is not provided", async () => {
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

  it("does NOT embed component source in Turn 2 prompt (tool mode)", async () => {
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
      fileToolContext: {
        owner: "o",
        repo: "r",
        branch: "main",
        token: "t",
        fileTree: TREE,
      },
    });

    // Calls: [0]=Turn1, [1..3]=Turn2 for each screen, [4]=Turn3.
    // Each Turn 2 call receives [system, user: Turn1, assistant: Turn1Resp,
    // user: Turn2]. We want the LAST user message — the Turn 2 prompt.
    for (let i = 1; i <= 3; i++) {
      const userMsgs = adapter.calls[i].messages.filter(
        (m) => m.role === "user",
      );
      const turn2UserMsg = userMsgs[userMsgs.length - 1];
      expect(turn2UserMsg).toBeDefined();
      const content = turn2UserMsg.content;
      // The component file path appears (the prompt tells the model which file
      // to readFile)
      expect(content).toMatch(/\.component\.ts/);
      // But NOT the source code from those files
      expect(content).not.toContain("export class HomeComponent");
      expect(content).not.toContain("export class DashboardComponent");
      expect(content).not.toContain("export class LoginComponent");
      expect(content).not.toContain("@Component({ template:");
    }
  });

  it("returns empty variants and skips Turn 2 when componentFile is hallucinated (tool mode)", async () => {
    const adapter = createMockAdapter([
      // Turn 1: returns a screen whose componentFile isn't in the preload
      // cache OR the fileTree — i.e., a hallucinated path.
      JSON.stringify([
        {
          id: "screen_ghost",
          path: "/ghost",
          componentFile: "src/app/ghost.component.ts",
          label: "Ghost",
          description: "Not a real file",
        },
      ]),
      // Turn 3: empty transitions
      JSON.stringify([]),
    ]);
    const pipeline = new AnalysisPipeline(adapter);

    const result = await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: [], // empty preload
      fileToolContext: {
        owner: "o",
        repo: "r",
        branch: "main",
        token: "t",
        fileTree: TREE, // also does NOT contain ghost.component.ts
      },
    });

    // Variants should be empty because canAnalyze is false
    expect(result.screens[0]!.variants).toEqual([]);
    // Only Turn 1 and Turn 3 were called — Turn 2 was skipped
    expect(adapter.calls).toHaveLength(2);
  });

  it("still extracts variants when componentFile is only in fileTree (not preloaded)", async () => {
    const adapter = createMockAdapter([
      JSON.stringify([
        {
          id: "screen_home",
          path: "/",
          // This file is in the TREE but not in the componentFiles preload
          componentFile: "src/app/home.component.ts",
          label: "Home",
          description: "Home",
        },
      ]),
      TURN2_HOME_RESPONSE,
      JSON.stringify([]), // Turn 3
    ]);
    const pipeline = new AnalysisPipeline(adapter);

    const result = await pipeline.run({
      framework: "angular",
      routingFiles: [SAMPLE_ROUTING_FILE],
      componentFiles: [], // empty preload — model must use the tools
      fileToolContext: {
        owner: "o",
        repo: "r",
        branch: "main",
        token: "t",
        fileTree: TREE,
      },
    });

    expect(result.screens[0]!.variants).toHaveLength(1);
    // 3 calls: Turn 1, Turn 2 for the one screen, Turn 3
    expect(adapter.calls).toHaveLength(3);
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
