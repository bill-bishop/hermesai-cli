import type { ToolSpec } from "../../core/types";

export const tool_delegate: ToolSpec = {
  type: "function",
  name: "delegate",
  description: "Hand off a clarified task to the Delegation agent.",
  parameters: { type: "object", properties: { task_brief: { type: "string" } }, required: ["task_brief"] },
  strict: false,
};

export const tool_plan: ToolSpec = {
  type: "function",
  name: "plan",
  description: "Ask Planning agent for a plan and references.",
  parameters: { type: "object", properties: { task_brief: { type: "string" } }, required: ["task_brief"] },
  strict: false,
};

export const tool_code: ToolSpec = {
  type: "function",
  name: "code",
  description: "Ask Coding agent for raw code for ONE file; harness will use output_path.",
  parameters: {
    type: "object",
    properties: {
      task_brief: { type: "string" },
      output_path: { type: "string", description: "Project-relative path the code will be written to." }
    },
    required: ["task_brief", "output_path"]
  },
  strict: false,
};

export const tool_exec: ToolSpec = {
  type: "function",
  name: "exec",
  description: "Execute Ubuntu shell commands",
  parameters: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "the shell command to execute" },
      cwd: { type: "string", description: "the relative path where the command should be executed" },
    },
    required: ["cmd"]
  },
  strict: false,
};

export const tool_readfile: ToolSpec = {
  type: "function",
  name: "readfile",
  description: "Read project file contents",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "the relative path to the file"},
    },
    required: ["filePath"],
  },
  strict: false,
};
