/**
 * Multi-Turn Analysis Pipeline
 *
 * Orchestrates the three-turn LLM analysis process:
 *   Turn 1 — Extract routes / screens
 *   Turn 2 — Extract state variants per screen
 *   Turn 3 — Extract transitions between screens
 *
 * Reference: SPEC.md §5.4, §5.5
 */

import type {
  AnalysisResult,
  Screen,
  Variant,
  Transition,
} from "@route-atlas/shared";
import type { LLMAdapter, ChatMessage } from "./copilot-client.js";
import type { FrameworkName } from "./framework-detector.js";
import { createCustomTools, type RepositoryContext } from "./custom-tools.js";
import {
  SYSTEM_PROMPT,
  buildTurn1Prompt,
  buildTurn2Prompt,
  buildTurn3Prompt,
} from "./prompts.js";

// ---------------------------------------------------------------------------
// Supported models (per SPEC.md §3)
// ---------------------------------------------------------------------------

export const SUPPORTED_MODELS = [
  "gpt-4.1",
  "claude-sonnet-4",
  "gemini-2.0-flash",
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export const DEFAULT_MODEL: SupportedModel = "gpt-4.1";

export function isSupportedModel(value: string): value is SupportedModel {
  return (SUPPORTED_MODELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Pipeline input
// ---------------------------------------------------------------------------

/**
 * Progress stages reported between pipeline turns.
 *
 * - `"analyzing_variants"` — emitted after Turn 1 completes, before Turn 2.
 * - `"analyzing_transitions"` — emitted after Turn 2 completes, before Turn 3.
 */
export type PipelineStage = "analyzing_variants" | "analyzing_transitions";

/**
 * Callback invoked between pipeline turns to report progress.
 */
export type OnPipelineProgress = (stage: PipelineStage) => void;

export interface AnalysisPipelineInput {
  /** Detected framework name (e.g. "nextjs-app", "react-router"). */
  framework: FrameworkName;

  /** Repo-relative paths of detected routing-definition files. */
  routingFilePaths: string[];

  /** Repo-relative paths of candidate component source files. */
  componentFilePaths: string[];

  /**
   * GitHub repository context used to back the custom file-exploration tools.
   * When provided, Copilot can call `readFile` / `searchFiles` / `grepFiles`
   * to fetch files on demand instead of receiving them pre-embedded.
   */
  repositoryContext: RepositoryContext;

  /** Which LLM model to use. Defaults to gpt-4.1. */
  model?: SupportedModel;

  /** Optional callback invoked between pipeline turns to report real progress. */
  onProgress?: OnPipelineProgress;
}

// ---------------------------------------------------------------------------
// Internal parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON response from the LLM, stripping optional markdown fences.
 *
 * @param raw       The raw LLM response string
 * @param validate  Optional runtime validator. Receives the parsed value and
 *                  should throw (or return false) if the shape is wrong.
 */
function parseLLMJson<T>(
  raw: string,
  validate?: (value: unknown) => boolean,
): T {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  const parsed: unknown = JSON.parse(cleaned);

  if (validate && !validate(parsed)) {
    throw new Error(
      `LLM returned JSON that failed runtime validation: ${cleaned.slice(0, 200)}`,
    );
  }

  return parsed as T;
}

// ---------------------------------------------------------------------------
// Raw shapes returned by the LLM (before we attach variants)
// ---------------------------------------------------------------------------

interface RawScreen {
  id: string;
  path: string;
  componentFile: string;
  label: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class AnalysisPipeline {
  private readonly adapter: LLMAdapter;

  constructor(adapter: LLMAdapter) {
    this.adapter = adapter;
  }

  /**
   * Run the full three-turn analysis and return an `AnalysisResult`.
   */
  async run(input: AnalysisPipelineInput): Promise<AnalysisResult> {
    const model = input.model ?? DEFAULT_MODEL;
    // Build the custom toolset once per run — all turns share the same tools
    // and the same repository context.
    const tools = createCustomTools(input.repositoryContext);
    const componentPathSet = new Set(input.componentFilePaths);
    // Full repo path index for the widened Turn 2 admission check below.
    // A component file may be present in the repo but not in the
    // pre-computed candidate list (e.g. because the LLM picked a file the
    // heuristic filters dropped, or supplied a path with a leading "./").
    const repoPathSet = new Set(
      input.repositoryContext.fileTree.map((entry) => entry.path),
    );

    const conversationHistory: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    // ------------------------------------------------------------------
    // Turn 1 — extract screens
    // ------------------------------------------------------------------
    const turn1Prompt = buildTurn1Prompt(
      input.framework,
      input.routingFilePaths,
    );
    conversationHistory.push({ role: "user", content: turn1Prompt });

    const turn1Response = await this.adapter.chatCompletion({
      model,
      messages: [...conversationHistory],
      tools,
    });

    conversationHistory.push({
      role: "assistant",
      content: turn1Response.content,
    });

    const isArray = (v: unknown): boolean => Array.isArray(v);

    const rawScreens = parseLLMJson<RawScreen[]>(
      turn1Response.content,
      isArray,
    );

    // Report progress: Turn 1 done, starting Turn 2
    input.onProgress?.("analyzing_variants");

    // ------------------------------------------------------------------
    // Turn 2 — extract variants for each screen (parallelised in batches)
    //
    // Turn 2 calls are independent per-screen and do NOT contribute to
    // the shared conversation history — only Turn 1 context is kept for
    // Turn 3 (the screen list is passed explicitly).
    // ------------------------------------------------------------------
    const TURN2_BATCH_SIZE = 5;

    const framework = input.framework;
    const pipelineTools = tools;

    async function extractVariants(
      adapter: LLMAdapter,
      rawScreen: RawScreen,
      knownComponentPaths: Set<string>,
      knownRepoPaths: Set<string>,
      baseMessages: ChatMessage[],
      selectedModel: string,
    ): Promise<Screen> {
      let variants: Variant[] = [];

      // Only issue a Turn 2 call when the LLM identified a component file.
      // Accept the path if it is a known candidate, a known repo file, or
      // either of those after stripping a leading "./". If the path is truly
      // unknown we skip the turn — `readFile` would otherwise fail anyway,
      // but skipping avoids a wasted round-trip. Paths that exist in the
      // repo but aren't in the candidate list are still tried — `readFile`
      // will handle the content fetch and fail gracefully if the file has
      // since moved.
      const componentFile = rawScreen.componentFile;
      const normalizedComponentFile = componentFile?.replace(/^\.\//, "");
      const shouldCallTurn2 =
        !!componentFile &&
        !!normalizedComponentFile &&
        (knownComponentPaths.has(componentFile) ||
          knownComponentPaths.has(normalizedComponentFile) ||
          knownRepoPaths.has(componentFile) ||
          knownRepoPaths.has(normalizedComponentFile));

      if (shouldCallTurn2) {
        const turn2Prompt = buildTurn2Prompt(
          rawScreen.id,
          rawScreen.componentFile,
          framework,
        );

        const turn2Response = await adapter.chatCompletion({
          model: selectedModel,
          messages: [...baseMessages, { role: "user", content: turn2Prompt }],
          tools: pipelineTools,
        });

        variants = parseLLMJson<Variant[]>(turn2Response.content, isArray);
      }

      return { ...rawScreen, variants };
    }

    const screensWithVariants: Screen[] = [];
    const turn1Context: ChatMessage[] = [...conversationHistory];

    for (let i = 0; i < rawScreens.length; i += TURN2_BATCH_SIZE) {
      const batch = rawScreens.slice(i, i + TURN2_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((screen) =>
          extractVariants(
            this.adapter,
            screen,
            componentPathSet,
            repoPathSet,
            turn1Context,
            model,
          ),
        ),
      );
      screensWithVariants.push(...batchResults);
    }

    // Report progress: Turn 2 done, starting Turn 3
    input.onProgress?.("analyzing_transitions");

    // ------------------------------------------------------------------
    // Turn 3 — extract transitions
    // ------------------------------------------------------------------
    const screenSummary = screensWithVariants.map((s) => ({
      id: s.id,
      path: s.path,
    }));

    const turn3Prompt = buildTurn3Prompt(
      screenSummary,
      input.componentFilePaths,
      input.framework,
    );
    conversationHistory.push({ role: "user", content: turn3Prompt });

    const turn3Response = await this.adapter.chatCompletion({
      model,
      messages: [...conversationHistory],
      tools,
    });

    const transitions = parseLLMJson<Transition[]>(
      turn3Response.content,
      isArray,
    );

    return {
      framework: input.framework,
      screens: screensWithVariants,
      transitions,
    };
  }
}
