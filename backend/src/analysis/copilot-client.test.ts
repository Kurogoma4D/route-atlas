import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Tool } from "@github/copilot-sdk";

// ---------------------------------------------------------------------------
// Mock @github/copilot-sdk BEFORE importing copilot-client
// ---------------------------------------------------------------------------

/**
 * Capture the arguments createSession is invoked with so tests can assert
 * that the correct `tools` / `availableTools` shape was passed.
 */
const createSessionCalls: Array<Record<string, unknown>> = [];
const mockSendAndWait = vi.fn().mockResolvedValue({
  data: { content: "[]" },
});
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

vi.mock("@github/copilot-sdk", () => {
  class MockCopilotClient {
    // constructor arguments are not asserted by these tests
    constructor(_opts: unknown) {}
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    createSession = vi.fn(async (opts: Record<string, unknown>) => {
      createSessionCalls.push(opts);
      return {
        sendAndWait: mockSendAndWait,
        disconnect: mockDisconnect,
      };
    });
  }
  return {
    CopilotClient: MockCopilotClient,
    approveAll: vi.fn(),
  };
});

import {
  CopilotClientManager,
  copilotAdapterFactory,
  type LLMAdapter,
  type LLMAdapterFactory,
} from "./copilot-client.js";

function createMockAdapter(): LLMAdapter {
  return {
    chatCompletion: vi.fn().mockResolvedValue({ content: "{}" }),
    dispose: vi.fn(),
  };
}

describe("CopilotClientManager", () => {
  let factory: LLMAdapterFactory;
  let manager: CopilotClientManager;
  let lastCreatedAdapter: LLMAdapter;

  beforeEach(() => {
    factory = vi.fn((_token: string) => {
      lastCreatedAdapter = createMockAdapter();
      return lastCreatedAdapter;
    });
    manager = new CopilotClientManager(factory);
  });

  it("creates a new client on first call for a user", () => {
    const adapter = manager.getClient("user-1", "token-1");
    expect(factory).toHaveBeenCalledWith("token-1");
    expect(adapter).toBe(lastCreatedAdapter);
    expect(manager.size).toBe(1);
  });

  it("returns existing client on subsequent calls for the same user", () => {
    const first = manager.getClient("user-1", "token-1");
    const second = manager.getClient("user-1", "token-1");
    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("creates separate clients for different users", () => {
    const a = manager.getClient("user-a", "token-a");
    const b = manager.getClient("user-b", "token-b");
    expect(a).not.toBe(b);
    expect(manager.size).toBe(2);
  });

  it("removeClient disposes and deletes the client", () => {
    const adapter = manager.getClient("user-1", "token-1");
    manager.removeClient("user-1");

    expect(adapter.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasClient("user-1")).toBe(false);
    expect(manager.size).toBe(0);
  });

  it("removeClient is a no-op for unknown user", () => {
    expect(() => manager.removeClient("unknown")).not.toThrow();
  });

  it("clear disposes all clients", () => {
    const a = manager.getClient("user-a", "token-a");
    const b = manager.getClient("user-b", "token-b");

    manager.clear();

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(manager.size).toBe(0);
  });

  it("hasClient returns correct status", () => {
    expect(manager.hasClient("user-1")).toBe(false);
    manager.getClient("user-1", "token-1");
    expect(manager.hasClient("user-1")).toBe(true);
  });

  it("disposes and recreates adapter when token changes", () => {
    const firstAdapter = manager.getClient("user-1", "token-1");
    const secondAdapter = manager.getClient("user-1", "token-2");

    // Old adapter should have been disposed
    expect(firstAdapter.dispose).toHaveBeenCalledTimes(1);
    // A new adapter should have been created
    expect(secondAdapter).not.toBe(firstAdapter);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenLastCalledWith("token-2");
    // Only one entry in the map
    expect(manager.size).toBe(1);
  });

  it("reuses adapter when same token is provided again", () => {
    const first = manager.getClient("user-1", "token-1");
    const second = manager.getClient("user-1", "token-1");

    expect(first).toBe(second);
    expect(first.dispose).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// CopilotLLMAdapter — chatCompletion tools branching
// ---------------------------------------------------------------------------

function makeFakeTool(name: string): Tool<unknown> {
  return {
    name,
    description: `desc-${name}`,
    handler: () => "ok",
  };
}

describe("CopilotLLMAdapter.chatCompletion", () => {
  beforeEach(() => {
    createSessionCalls.length = 0;
    mockSendAndWait.mockClear();
    mockDisconnect.mockClear();
  });

  it("passes tools + availableTools when custom tools are provided", async () => {
    const adapter = copilotAdapterFactory("tok");
    const tools = [makeFakeTool("readFile"), makeFakeTool("searchFiles")];

    await adapter.chatCompletion({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools,
    });

    expect(createSessionCalls).toHaveLength(1);
    const opts = createSessionCalls[0];
    expect(opts.tools).toBe(tools);
    expect(opts.availableTools).toEqual(["readFile", "searchFiles"]);
  });

  it("passes availableTools: [] and omits tools when tools are not provided", async () => {
    const adapter = copilotAdapterFactory("tok");

    await adapter.chatCompletion({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });

    expect(createSessionCalls).toHaveLength(1);
    const opts = createSessionCalls[0];
    expect(opts.availableTools).toEqual([]);
    expect("tools" in opts).toBe(false);
  });

  it("treats an empty tools array as no tools", async () => {
    const adapter = copilotAdapterFactory("tok");

    await adapter.chatCompletion({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [],
    });

    expect(createSessionCalls).toHaveLength(1);
    const opts = createSessionCalls[0];
    expect(opts.availableTools).toEqual([]);
    expect("tools" in opts).toBe(false);
  });

  it("throws when messages contains only a system entry", async () => {
    const adapter = copilotAdapterFactory("tok");

    await expect(
      adapter.chatCompletion({
        model: "gpt-4.1",
        messages: [{ role: "system", content: "sys" }],
      }),
    ).rejects.toThrow(/non-system message/);
  });
});
