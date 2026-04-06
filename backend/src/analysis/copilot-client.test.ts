import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CopilotClientManager,
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
});
