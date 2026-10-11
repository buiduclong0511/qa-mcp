import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function respondText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function respondJson(value: unknown): CallToolResult {
  return respondText(JSON.stringify(value, null, 2));
}

export function respondError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Runs a handler and turns thrown errors into MCP error results instead of crashing the server. */
export async function runSafe(fn: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    return respondJson(await fn());
  } catch (err) {
    return respondError(err instanceof Error ? err.message : String(err));
  }
}
