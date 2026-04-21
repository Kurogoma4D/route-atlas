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

import type { Tool } from "@github/copilot-sdk";
import type {
  AnalysisResult,
  Screen,
  Variant,
  Transition,
} from "@route-atlas/shared";
import type { LLMAdapter, ChatMessage } from "./copilot-client.js";
import type { FrameworkName } from "./framework-detector.js";
import { createFileTools, type FileToolsContext } from "./file-tools.js";
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

  /** Routing definition files with their contents. */
  routingFiles: { path: string; content: string }[];

  /**
   * Candidate component source file paths that routes may reference. Only
   * the path list is required here — contents are fetched on demand by the
   * LLM via the custom `readFile` / `grepFiles` tools.
   */
  componentFilePaths: string[];

  /**
   * Repository context + file tree used to build the custom tools that
   * Copilot can call to fetch files on demand. Must be provided when the
   * pipeline runs against a real repository.
   */
  fileToolsContext?: FileToolsContext;

  /**
   * Pre-built tools to expose to the LLM. If omitted, the pipeline will
   * build them from {@link fileToolsContext}. At least one of the two
   * must be provided.
   */
  tools?: Tool<unknown>[];

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
    const tools = resolveTools(input);
    const conversationHistory: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    // ------------------------------------------------------------------
    // Turn 1 — extract screens
    //
    // Routing files are typically small and fully enumerated by the
    // framework detector, so we keep embedding them. The LLM is still
    // allowed to reach for `readFile` to resolve referenced components
    // (e.g. code-based route definitions that import pages lazily).
    // ------------------------------------------------------------------
    const turn1Prompt = buildTurn1Prompt(
      input.framework,
      input.routingFiles,
      input.componentFilePaths,
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
    // Each call instructs the LLM to fetch the component source via
    // `readFile` (and any additional helpers / hooks referenced from it).
    // Turn 2 calls are independent and do NOT contribute to the shared
    // conversation history — only Turn 1 context is kept for Turn 3.
    // ------------------------------------------------------------------
    const TURN2_BATCH_SIZE = 5;

    const extractVariants = async (
      adapter: LLMAdapter,
      rawScreen: RawScreen,
      baseMessages: ChatMessage[],
      selectedModel: string,
    ): Promise<Screen> => {
      const turn2Prompt = buildTurn2Prompt(
        rawScreen.id,
        rawScreen.componentFile,
        input.framework,
      );

      const turn2Response = await adapter.chatCompletion({
        model: selectedModel,
        messages: [...baseMessages, { role: "user", content: turn2Prompt }],
        tools,
      });

      const variants = parseLLMJson<Variant[]>(turn2Response.content, isArray);
      return { ...rawScreen, variants };
    };

    const screensWithVariants: Screen[] = [];
    const turn1Context: ChatMessage[] = [...conversationHistory];

    for (let i = 0; i < rawScreens.length; i += TURN2_BATCH_SIZE) {
      const batch = rawScreens.slice(i, i + TURN2_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((screen) =>
          extractVariants(this.adapter, screen, turn1Context, model),
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
      componentFile: s.componentFile,
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

/**
 * Resolve the tool set for a pipeline run. Callers may supply tools directly
 * (useful for tests) or provide a {@link FileToolsContext} to have them built
 * from a repository's file tree. When neither is present the pipeline runs
 * without tools — acceptable for tests that hand-craft every LLM response.
 */
function resolveTools(
  input: AnalysisPipelineInput,
): Tool<unknown>[] | undefined {
  if (input.tools && input.tools.length > 0) return input.tools;
  if (input.fileToolsContext) return createFileTools(input.fileToolsContext);
  return undefined;
}
