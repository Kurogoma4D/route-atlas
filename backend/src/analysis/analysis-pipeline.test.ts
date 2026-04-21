import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AnalysisPipeline,
  isSupportedModel,
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
  type AnalysisPipelineInput,
} from "./analysis-pipeline.js";
import type { LLMAdapter, ChatCompletionOptions } from "./copilot-client.js";
import type { RepositoryContext } from "./custom-tools.js";
import type { TreeEntry } from "./github-file-fetcher.js";

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

const SAMPLE_ROUTING_FILE_PATH = "src/app/routes.ts";

const SAMPLE_COMPONENT_FILE_PATHS = [
  "src/app/home.component.ts",
  "src/app/dashboard.component.ts",
  "src/app/login.component.ts",
];

function makeTreeEntry(path: string): TreeEntry {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha: `sha_${path}`,
    size: 100,
    url: `https://api.github.com/repos/owner/repo/git/blobs/sha_${path}`,
  };
}

const SAMPLE_REPOSITORY_CONTEXT: RepositoryContext = {
  owner: "owner",
  repo: "repo",
  ref: "main",
  token: "token",
  fileTree: [
    makeTreeEntry(SAMPLE_ROUTING_FILE_PATH),
    ...SAMPLE_COMPONENT_FILE_PATHS.map(makeTreeEntry),
  ],
};

function baseInput(
  overrides: Partial<AnalysisPipelineInput> = {},
): AnalysisPipelineInput {
  return {
    framework: "angular",
    routingFilePaths: [SAMPLE_ROUTING_FILE_PATH],
    componentFilePaths: SAMPLE_COMPONENT_FILE_PATHS,
    repositoryContext: SAMPLE_REPOSITORY_CONTEXT,
    ...overrides,
  };
}

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
    const result = await pipeline.run(baseInput());

    expect(result.framework).toBe("angular");
    expect(result.screens).toHaveLength(3);
    expect(result.transitions).toHaveLength(1);
  });

  it("Turn 1 extracts all screens", async () => {
    const result = await pipeline.run(baseInput());

    const ids = result.screens.map((s) => s.id);
    expect(ids).toContain("screen_home");
    expect(ids).toContain("screen_dashboard");
    expect(ids).toContain("screen_login");
  });

  it("Turn 2 attaches variants to the correct screens", async () => {
    const result = await pipeline.run(baseInput());

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
    const result = await pipeline.run(baseInput());

    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toMatchObject({
      from: "screen_login",
      to: "screen_dashboard",
      method: "router.navigate",
    });
  });

  it("calls onProgress callback between turns", async () => {
    const stages: string[] = [];
    await pipeline.run(
      baseInput({
        onProgress: (stage) => {
          stages.push(stage);
        },
      }),
    );

    expect(stages).toEqual(["analyzing_variants", "analyzing_transitions"]);
  });

  it("uses the default model when none specified", async () => {
    await pipeline.run(baseInput());

    // All calls should use the default model
    for (const call of adapter.calls) {
      expect(call.model).toBe(DEFAULT_MODEL);
    }
  });

  it("respects a custom model parameter", async () => {
    await pipeline.run(baseInput({ model: "claude-sonnet-4" }));

    for (const call of adapter.calls) {
      expect(call.model).toBe("claude-sonnet-4");
    }
  });

  it("forwards custom tools to every chat completion call", async () => {
    await pipeline.run(baseInput());

    for (const call of adapter.calls) {
      expect(call.tools).toBeDefined();
      const names = call.tools?.map((t) => t.name) ?? [];
      expect(names).toContain("readFile");
      expect(names).toContain("searchFiles");
      expect(names).toContain("grepFiles");
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

    const result = await fencedPipeline.run(baseInput());

    expect(result.screens).toHaveLength(3);
  });

  it("issues a Turn 2 call when the component file is in the repo tree but not in the candidate list", async () => {
    // The LLM may pick a component file that our heuristic filter dropped
    // (e.g. a .ts file outside the narrower candidate set). As long as the
    // file exists in the repository we should still run Turn 2.
    const orphanPath = "src/app/orphan.component.ts";
    const turn1ResponseOrphan = JSON.stringify([
      {
        id: "screen_orphan",
        path: "/orphan",
        componentFile: orphanPath,
        label: "Orphan",
        description: "Component file outside candidate list",
      },
    ]);
    const turn2OrphanResponse = JSON.stringify([
      {
        id: "variant_default_orphan",
        label: "Default",
        condition: "Always",
        type: "default",
      },
    ]);
    const orphanAdapter = createMockAdapter([
      turn1ResponseOrphan,
      turn2OrphanResponse,
      JSON.stringify([]), // Turn 3
    ]);
    const orphanPipeline = new AnalysisPipeline(orphanAdapter);

    const result = await orphanPipeline.run(
      baseInput({
        componentFilePaths: [], // not a candidate
        repositoryContext: {
          ...SAMPLE_REPOSITORY_CONTEXT,
          // but present in the repo tree
          fileTree: [
            ...SAMPLE_REPOSITORY_CONTEXT.fileTree,
            makeTreeEntry(orphanPath),
          ],
        },
      }),
    );

    // 3 calls == Turn 1 + Turn 2 (for orphan) + Turn 3
    expect(orphanAdapter.calls).toHaveLength(3);
    expect(result.screens[0]!.variants).toHaveLength(1);
    expect(result.screens[0]!.variants[0]!.type).toBe("default");
  });

  it("accepts a componentFile with a leading './' when normalization matches the tree", async () => {
    const turn1ResponseDotSlash = JSON.stringify([
      {
        id: "screen_home",
        path: "/",
        // LLM may emit paths with a leading "./"
        componentFile: "./src/app/home.component.ts",
        label: "Home",
        description: "Home",
      },
    ]);
    const dotSlashAdapter = createMockAdapter([
      turn1ResponseDotSlash,
      TURN2_HOME_RESPONSE,
      JSON.stringify([]), // Turn 3
    ]);
    const dotSlashPipeline = new AnalysisPipeline(dotSlashAdapter);

    const result = await dotSlashPipeline.run(baseInput());

    // Turn 1 + Turn 2 + Turn 3
    expect(dotSlashAdapter.calls).toHaveLength(3);
    expect(result.screens[0]!.variants).toHaveLength(1);
  });

  it("assigns empty variants when the component file is not in the tree", async () => {
    const adapterWithMissing = createMockAdapter([
      JSON.stringify([
        {
          id: "screen_missing",
          path: "/missing",
          componentFile: "src/app/does-not-exist.ts",
          label: "Missing",
          description: "Component file not in tree",
        },
      ]),
      // No Turn 2 call for this screen since source is missing
      JSON.stringify([]), // Turn 3
    ]);
    const missingPipeline = new AnalysisPipeline(adapterWithMissing);

    const result = await missingPipeline.run(
      baseInput({
        framework: "react-router",
        // Empty component path list — unknown components trigger the skip branch.
        componentFilePaths: [],
      }),
    );

    expect(result.screens[0]!.variants).toEqual([]);
  });

  it("throws when LLM returns non-JSON content", async () => {
    const badAdapter = createMockAdapter(["This is not JSON at all, sorry!"]);
    const badPipeline = new AnalysisPipeline(badAdapter);

    await expect(badPipeline.run(baseInput())).rejects.toThrow(); // SyntaxError from JSON.parse
  });

  it("throws when LLM returns valid JSON but wrong shape (object instead of array)", async () => {
    const badAdapter = createMockAdapter([JSON.stringify({ not: "an array" })]);
    const badPipeline = new AnalysisPipeline(badAdapter);

    await expect(badPipeline.run(baseInput())).rejects.toThrow(
      "failed runtime validation",
    );
  });

  it("propagates LLM errors", async () => {
    const errorAdapter: LLMAdapter = {
      chatCompletion: vi
        .fn()
        .mockRejectedValue(new Error("Copilot API unavailable")),
      dispose: vi.fn(),
    };
    const errorPipeline = new AnalysisPipeline(errorAdapter);

    await expect(errorPipeline.run(baseInput())).rejects.toThrow(
      "Copilot API unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// Model selection helpers
// ---------------------------------------------------------------------------

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
