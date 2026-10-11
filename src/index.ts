#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb } from "./db/index.js";
import { registerCaseTools } from "./tools/case-tools.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerRunTools } from "./tools/run-tools.js";

const server = new McpServer({ name: "qa-mcp", version: "0.1.0" });

registerProjectTools(server);
registerCaseTools(server);
registerRunTools(server);

async function main() {
  getDb();
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("Failed to start qa-mcp server:", error);
  process.exit(1);
});
