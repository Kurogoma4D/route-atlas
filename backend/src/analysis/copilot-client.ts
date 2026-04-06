/**
 * Copilot Client Abstraction & Per-User Instance Management
 *
 * Since the @github/copilot-sdk package does not exist yet, this module
 * provides a clean adapter interface (`LLMAdapter`) that can be swapped
 * out when the real SDK becomes available.
 *
 * Reference: SPEC.md §4.2, §8.2
 */

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
}

/** The response from an LLM chat completion call. */
export interface ChatCompletionResponse {
  content: string;
}

/**
 * Abstraction over the underlying LLM provider.
 *
 * When the real Copilot SDK ships, implement this interface by delegating
 * to `CopilotClient.chat.completions.create(...)`.
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
 * This is what gets swapped out when the real SDK becomes available.
 */
export type LLMAdapterFactory = (githubToken: string) => LLMAdapter;

export interface CopilotClientEntry {
  adapter: LLMAdapter;
  createdAt: number;
}

export class CopilotClientManager {
  private readonly clients = new Map<string, CopilotClientEntry>();
  private readonly factory: LLMAdapterFactory;

  constructor(factory: LLMAdapterFactory) {
    this.factory = factory;
  }

  /**
   * Get or create an `LLMAdapter` for the given user.
   *
   * @param userId  Unique user identifier (e.g. GitHub login)
   * @param token   The user's OAuth access token
   */
  getClient(userId: string, token: string): LLMAdapter {
    const existing = this.clients.get(userId);
    if (existing) {
      return existing.adapter;
    }

    const adapter = this.factory(token);
    this.clients.set(userId, { adapter, createdAt: Date.now() });
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
