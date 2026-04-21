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
import type { Tool } from "@github/copilot-sdk";
import type { LLMAdapter, ChatMessage } from "./copilot-client.js";
import type { FrameworkName } from "./framework-detector.js";
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_WITH_TOOLS,
  buildTurn1Prompt,
  buildTurn2Prompt,
  buildTurn2PromptWithTools,
  buildTurn3Prompt,
  buildTurn3PromptWithTools,
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
   * All component source files that may be referenced by routes.
   * Keyed by file path so Turn 2 can look up individual components.
   *
   * Optional when {@link customTools} is supplied — in that case the LLM
   * fetches files on demand via the tools instead of receiving full
   * contents in the prompt. If both are provided, the embedded contents
   * are still used as the happy-path for Turn 2 look-up, and the tools
   * remain available for the LLM to pull additional context.
   */
  componentFiles?: { path: string; content: string }[];

  /**
   * Paths of all candidate component files (full list, not just the ones
   * whose contents were fetched). Provided to the LLM in Turn 3 so it
   * can choose which ones to inspect via tools.
   *
   * Only used when {@link customTools} is set.
   */
  candidateComponentPaths?: string[];

  /**
   * Custom tools (readFile, searchFiles, grepFiles) to hand to the LLM.
   *
   * When provided, Turn 2 and Turn 3 use the tool-assisted prompts: they
   * ask the model to fetch files on demand instead of embedding full
   * contents. Turn 1 remains embedded (routing files are already a small,
   * curated set).
   */
  customTools?: Tool<unknown>[];

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
    const useTools =
      input.customTools !== undefined && input.customTools.length > 0;
    const componentFiles = input.componentFiles ?? [];
    const conversationHistory: ChatMessage[] = [
      {
        role: "system",
        content: useTools ? SYSTEM_PROMPT_WITH_TOOLS : SYSTEM_PROMPT,
      },
    ];

    // ------------------------------------------------------------------
    // Turn 1 — extract screens
    // ------------------------------------------------------------------
    const turn1Prompt = buildTurn1Prompt(input.framework, input.routingFiles);
    conversationHistory.push({ role: "user", content: turn1Prompt });

    const turn1Response = await this.adapter.chatCompletion({
      model,
      messages: [...conversationHistory],
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

    async function extractVariants(
      adapter: LLMAdapter,
      rawScreen: RawScreen,
      componentFilesLocal: { path: string; content: string }[],
      baseMessages: ChatMessage[],
      selectedModel: string,
      tools: Tool<unknown>[] | undefined,
    ): Promise<Screen> {
      const componentSource = componentFilesLocal.find(
        (f) => f.path === rawScreen.componentFile,
      );

      let variants: Variant[] = [];

      // With tools available, ask the LLM to fetch the file itself. Otherwise
      // fall back to the legacy "embed source" flow (which requires the file
      // contents to already be present in `componentFilesLocal`).
      if (tools !== undefined && tools.length > 0) {
        const turn2Prompt = buildTurn2PromptWithTools(
          rawScreen.id,
          rawScreen.componentFile,
          input.framework,
        );

        const turn2Response = await adapter.chatCompletion({
          model: selectedModel,
          messages: [...baseMessages, { role: "user", content: turn2Prompt }],
          tools,
        });

        variants = parseLLMJson<Variant[]>(turn2Response.content, isArray);
      } else if (componentSource) {
        const turn2Prompt = buildTurn2Prompt(
          rawScreen.id,
          rawScreen.componentFile,
          componentSource.content,
          input.framework,
        );

        const turn2Response = await adapter.chatCompletion({
          model: selectedModel,
          messages: [...baseMessages, { role: "user", content: turn2Prompt }],
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
            componentFiles,
            turn1Context,
            model,
            input.customTools,
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
    let turn3Prompt: string;

    if (useTools) {
      const screenSummary = screensWithVariants.map((s) => ({
        id: s.id,
        path: s.path,
        componentFile: s.componentFile,
      }));
      const candidates =
        input.candidateComponentPaths ?? componentFiles.map((f) => f.path);

      turn3Prompt = buildTurn3PromptWithTools(
        screenSummary,
        candidates,
        input.framework,
      );
    } else {
      const screenSummary = screensWithVariants.map((s) => ({
        id: s.id,
        path: s.path,
      }));

      turn3Prompt = buildTurn3Prompt(
        screenSummary,
        componentFiles,
        input.framework,
      );
    }

    conversationHistory.push({ role: "user", content: turn3Prompt });

    const turn3Response = await this.adapter.chatCompletion({
      model,
      messages: [...conversationHistory],
      ...(useTools ? { tools: input.customTools ?? [] } : {}),
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
