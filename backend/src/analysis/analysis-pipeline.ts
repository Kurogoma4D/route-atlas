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

export interface AnalysisPipelineInput {
  /** Detected framework name (e.g. "nextjs-app", "react-router"). */
  framework: string;

  /** Routing definition files with their contents. */
  routingFiles: { path: string; content: string }[];

  /**
   * All component source files that may be referenced by routes.
   * Keyed by file path so Turn 2 can look up individual components.
   */
  componentFiles: { path: string; content: string }[];

  /** Which LLM model to use. Defaults to gpt-4.1. */
  model?: SupportedModel;
}

// ---------------------------------------------------------------------------
// Internal parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON response from the LLM, stripping optional markdown fences.
 */
function parseLLMJson<T>(raw: string): T {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  return JSON.parse(cleaned) as T;
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
    const conversationHistory: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
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

    const rawScreens = parseLLMJson<RawScreen[]>(turn1Response.content);

    // ------------------------------------------------------------------
    // Turn 2 — extract variants for each screen
    // ------------------------------------------------------------------
    const screensWithVariants: Screen[] = [];

    for (const rawScreen of rawScreens) {
      const componentSource = input.componentFiles.find(
        (f) => f.path === rawScreen.componentFile,
      );

      let variants: Variant[] = [];

      if (componentSource) {
        const turn2Prompt = buildTurn2Prompt(
          rawScreen.id,
          rawScreen.componentFile,
          componentSource.content,
        );

        conversationHistory.push({ role: "user", content: turn2Prompt });

        const turn2Response = await this.adapter.chatCompletion({
          model,
          messages: [...conversationHistory],
        });

        conversationHistory.push({
          role: "assistant",
          content: turn2Response.content,
        });

        variants = parseLLMJson<Variant[]>(turn2Response.content);
      }

      screensWithVariants.push({
        ...rawScreen,
        variants,
      });
    }

    // ------------------------------------------------------------------
    // Turn 3 — extract transitions
    // ------------------------------------------------------------------
    const screenSummary = screensWithVariants.map((s) => ({
      id: s.id,
      path: s.path,
    }));

    const turn3Prompt = buildTurn3Prompt(screenSummary, input.componentFiles);
    conversationHistory.push({ role: "user", content: turn3Prompt });

    const turn3Response = await this.adapter.chatCompletion({
      model,
      messages: [...conversationHistory],
    });

    const transitions = parseLLMJson<Transition[]>(turn3Response.content);

    return {
      framework: input.framework,
      screens: screensWithVariants,
      transitions,
    };
  }
}
