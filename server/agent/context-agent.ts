//This is gonna be inspired by the ArchAgent paper by Rusheng Pan et al 

import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Analyze the architecture of this codebase",
  options: {
    allowedTools: ["Read", "Grep", "Glob", "Task"],
    agents: {
      "code-analyzer": {
        description: "Codebase analysis and system understanding",
        prompt: `You are a program comprehension agent. Analyze code structure,
identify overarching functionality, and extract business logic to help product managers understand the codebase.`,
        // Read-only tools: no Edit, Write, or Bash access
        tools: ["Read", "Grep", "Glob"]
      }
    }
  }
})) {
  if ("result" in message) console.log(message.result);
}