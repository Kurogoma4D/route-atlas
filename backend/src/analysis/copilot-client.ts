/**
 * Copilot Client Abstraction & Per-User Instance Management
 *
 * Uses the @github/copilot-sdk to communicate with GitHub Copilot CLI
 * for LLM chat completions. Each user gets their own CopilotClient
 * instance authenticated with their OAuth token.
 *
 * Reference: SPEC.md §4.2, §8.2
 */

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";

// ---------------------------------------------------------------------------
// LLM Adapter interface — the abstraction boundary
// ---------------------------------------------------------------------------

/** A single message in a multi-turn conversation. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options for a chat completion request. */
export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /**
   * Optional custom tools the model may invoke during this turn.
   *
   * When present, the underlying Copilot session is configured with these
   * tools enabled (bypassing the default "disable all built-in tools"
   * behaviour). Passing an empty array or omitting the field disables all
   * tools for the turn.
   */
  tools?: Tool<unknown>[];
}

/** The response from an LLM chat completion call. */
export interface ChatCompletionResponse {
  content: string;
}

/**
 * Abstraction over the underlying LLM provider.
 */
export interface LLMAdapter {
  chatCompletion(
    options: ChatCompletionOptions,
  ): Promise<ChatCompletionResponse>;

  /**
   * Release any resources held by this adapter (e.g. close HTTP connections).
   * Called when the per-user client is cleaned up.
   */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Copilot SDK-based LLM Adapter
// ---------------------------------------------------------------------------

/**
 * LLM adapter backed by the @github/copilot-sdk.
 *
 * Each `chatCompletion` call creates a fresh session with the system message
 * set via `replace` mode, then sends the last user message. For multi-turn
 * conversations, prior assistant/user exchanges are included in the prompt
 * context to maintain coherence.
 */
class CopilotLLMAdapter implements LLMAdapter {
  private client: CopilotClient;
  private started = false;

  constructor(githubToken: string) {
    this.client = new CopilotClient({
      githubToken,
      useLoggedInUser: false,
    });
  }

  async chatCompletion(
    options: ChatCompletionOptions,
  ): Promise<ChatCompletionResponse> {
    if (!this.started) {
      await this.client.start();
      this.started = true;
    }

    // Extract system message and build the user prompt
    const systemMsg =
      options.messages.find((m) => m.role === "system")?.content ?? "";

    // Collect non-system messages; combine prior turns into context
    const nonSystemMsgs = options.messages.filter((m) => m.role !== "system");
    if (nonSystemMsgs.length === 0) {
      throw new Error(
        "chatCompletion: messages must include at least one non-system message.",
      );
    }
    const lastUserMsg = nonSystemMsgs[nonSystemMsgs.length - 1];

    // Build context from prior turns (if any) to include in the prompt
    const priorTurns = nonSystemMsgs.slice(0, -1);
    let prompt = "";
    if (priorTurns.length > 0) {
      const context = priorTurns
        .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
        .join("\n\n");
      prompt = `Here is the prior conversation context:\n\n${context}\n\nNow, respond to the following:\n\n${lastUserMsg.content}`;
    } else {
      prompt = lastUserMsg.content;
    }

    // When custom tools are provided, expose only those tools to Copilot.
    // Otherwise, disable all built-in tools (the default chat-completion mode).
    // Bind the narrowed tools array to a local so TS tracks the non-null type
    // into the createSession call without needing `!`.
    const customTools =
      options.tools !== undefined && options.tools.length > 0
        ? options.tools
        : undefined;

    const session = await this.client.createSession({
      model: options.model,
      onPermissionRequest: approveAll,
      systemMessage: {
        mode: "replace",
        content: systemMsg,
      },
      ...(customTools
        ? {
            tools: customTools,
            availableTools: customTools.map((t) => t.name),
          }
        : { availableTools: [] }),
    });

    try {
      const response = await session.sendAndWait(
        { prompt },
        300_000, // 5 min timeout
      );

      const content = response?.data?.content ?? "[]";
      return { content };
    } finally {
      await session.disconnect();
    }
  }

  dispose(): void {
    if (this.started) {
      this.client.stop().catch(() => {});
      this.started = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Copilot subscription error
// ---------------------------------------------------------------------------

export class CopilotSubscriptionError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "A GitHub Copilot subscription (Pro or higher) is required to use this feature.",
    );
    this.name = "CopilotSubscriptionError";
  }
}

// ---------------------------------------------------------------------------
// Per-user CopilotClient management (Map-based, per SPEC.md §8.2)
// ---------------------------------------------------------------------------

/**
 * Factory function type that creates an `LLMAdapter` for a given user token.
 */
export type LLMAdapterFactory = (githubToken: string) => LLMAdapter;

/**
 * Default factory that creates a real Copilot SDK adapter.
 */
export const copilotAdapterFactory: LLMAdapterFactory = (githubToken: string) =>
  new CopilotLLMAdapter(githubToken);

export interface CopilotClientEntry {
  adapter: LLMAdapter;
  tokenHash: string;
}

/**
 * Produce a simple hash of a token string for comparison purposes.
 * Uses djb2 algorithm — not cryptographic, but sufficient for change detection.
 */
export function hashToken(token: string): string {
  let hash = 5381;
  for (let i = 0; i < token.length; i++) {
    hash = (hash * 33) ^ token.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

export class CopilotClientManager {
  private readonly clients = new Map<string, CopilotClientEntry>();
  private readonly factory: LLMAdapterFactory;

  constructor(factory?: LLMAdapterFactory) {
    this.factory = factory ?? copilotAdapterFactory;
  }

  /**
   * Get or create an `LLMAdapter` for the given user.
   *
   * If the token has changed since the last call (detected via hash comparison),
   * the stale adapter is disposed and a fresh one is created.
   *
   * @param userId  Unique user identifier (e.g. GitHub login)
   * @param token   The user's OAuth access token
   */
  getClient(userId: string, token: string): LLMAdapter {
    const incoming = hashToken(token);
    const existing = this.clients.get(userId);

    if (existing && existing.tokenHash === incoming) {
      return existing.adapter;
    }

    // Token changed (or first call) — dispose old adapter if present
    if (existing) {
      existing.adapter.dispose();
    }

    const adapter = this.factory(token);
    this.clients.set(userId, { adapter, tokenHash: incoming });
    return adapter;
  }

  /**
   * Dispose and remove the client for a given user.
   * Should be called after an analysis completes.
   */
  removeClient(userId: string): void {
    const entry = this.clients.get(userId);
    if (entry) {
      entry.adapter.dispose();
      this.clients.delete(userId);
    }
  }

  /** Check whether a client exists for the given user. */
  hasClient(userId: string): boolean {
    return this.clients.has(userId);
  }

  /** Return the number of active clients. */
  get size(): number {
    return this.clients.size;
  }

  /** Dispose and remove all clients. */
  clear(): void {
    for (const [, entry] of this.clients) {
      entry.adapter.dispose();
    }
    this.clients.clear();
  }
}
