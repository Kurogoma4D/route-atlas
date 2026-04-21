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
import { createFileTools, type FileToolContext } from "./file-tools.js";
import type { Tool } from "@github/copilot-sdk";
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_WITH_TOOLS,
  buildTurn1Prompt,
  buildTurn2Prompt,
  buildTurn3Prompt,
  buildTurn1PromptWithTools,
  buildTurn2PromptWithTools,
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
   */
  componentFiles: { path: string; content: string }[];

  /** Which LLM model to use. Defaults to gpt-4.1. */
  model?: SupportedModel;

  /** Optional callback invoked between pipeline turns to report real progress. */
  onProgress?: OnPipelineProgress;

  /**
   * When present, the pipeline runs in tool-driven mode: file contents are
   * NOT embedded in the prompt; instead Copilot fetches them on demand via
   * the `readFile` / `searchFiles` / `grepFiles` custom tools.
   *
   * The pipeline still uses {@link AnalysisPipelineInput.routingFiles} and
   * {@link AnalysisPipelineInput.componentFiles} as hints (their paths are
   * listed in the prompt) and as the preload cache — avoiding a redundant
   * fetch when the model `readFile`s a path already on hand.
   */
  fileToolContext?: Pick<
    FileToolContext,
    "owner" | "repo" | "branch" | "token" | "fileTree"
  >;
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
    const toolMode = input.fileToolContext !== undefined;

    // Build a preload cache and custom tools (only used in tool mode).
    // The cache is shared across all three turns so files read in Turn 1
    // don't need to be fetched again in Turn 3.
    const preloadedContents = new Map<string, string>();
    for (const f of input.routingFiles)
      preloadedContents.set(f.path, f.content);
    for (const f of input.componentFiles)
      preloadedContents.set(f.path, f.content);

    let tools: Tool<unknown>[] | undefined;
    if (input.fileToolContext) {
      const ctx: FileToolContext = {
        ...input.fileToolContext,
        preloadedContents,
      };
      tools = createFileTools(ctx);
    }

    const systemPrompt = toolMode ? SYSTEM_PROMPT_WITH_TOOLS : SYSTEM_PROMPT;
    const conversationHistory: ChatMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    // ------------------------------------------------------------------
    // Turn 1 — extract screens
    // ------------------------------------------------------------------
    const turn1Prompt = toolMode
      ? buildTurn1PromptWithTools(
          input.framework,
          input.routingFiles.map((f) => f.path),
        )
      : buildTurn1Prompt(input.framework, input.routingFiles);
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

    async function extractVariants(
      adapter: LLMAdapter,
      rawScreen: RawScreen,
      componentFiles: { path: string; content: string }[],
      fileTreePaths: Set<string> | undefined,
      baseMessages: ChatMessage[],
      selectedModel: string,
      turnTools: Tool<unknown>[] | undefined,
    ): Promise<Screen> {
      const componentSource = componentFiles.find(
        (f) => f.path === rawScreen.componentFile,
      );
      const componentInTree = fileTreePaths?.has(rawScreen.componentFile);

      // In tool mode, proceed as long as the file exists somewhere — either in
      // the preload cache (componentSource) or in the full file tree.
      // In non-tool mode, only proceed when we already have the source.
      const canAnalyze = turnTools
        ? Boolean(componentSource) || Boolean(componentInTree)
        : Boolean(componentSource);

      let variants: Variant[] = [];

      if (canAnalyze) {
        const turn2Prompt = turnTools
          ? buildTurn2PromptWithTools(rawScreen.id, rawScreen.componentFile)
          : buildTurn2Prompt(
              rawScreen.id,
              rawScreen.componentFile,
              componentSource!.content,
              input.framework,
            );

        const turn2Response = await adapter.chatCompletion({
          model: selectedModel,
          messages: [...baseMessages, { role: "user", content: turn2Prompt }],
          tools: turnTools,
        });

        variants = parseLLMJson<Variant[]>(turn2Response.content, isArray);
      }

      return { ...rawScreen, variants };
    }

    const screensWithVariants: Screen[] = [];
    const turn1Context: ChatMessage[] = [...conversationHistory];

    // Hoist the file-tree path set once before the batch loop so each
    // extractVariants call does an O(1) membership check instead of O(n)
    // `fileTree.some(...)` inside the Promise.all batch.
    const fileTreePaths = input.fileToolContext?.fileTree
      ? new Set(input.fileToolContext.fileTree.map((e) => e.path))
      : undefined;

    for (let i = 0; i < rawScreens.length; i += TURN2_BATCH_SIZE) {
      const batch = rawScreens.slice(i, i + TURN2_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((screen) =>
          extractVariants(
            this.adapter,
            screen,
            input.componentFiles,
            fileTreePaths,
            turn1Context,
            model,
            tools,
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

    const turn3Prompt = toolMode
      ? buildTurn3PromptWithTools(
          screenSummary,
          // Prefer the broader file-tree paths when available so the model can
          // discover files beyond the preload set. Fall back to preload paths.
          input.fileToolContext
            ? input.fileToolContext.fileTree.map((e) => e.path)
            : input.componentFiles.map((f) => f.path),
        )
      : buildTurn3Prompt(screenSummary, input.componentFiles, input.framework);
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
