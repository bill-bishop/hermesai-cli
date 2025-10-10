export type Role = "system" | "user" | "assistant" | "tool";

export interface Msg {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function" | string;
  name: string;
  description?: string;
  parameters: any;
  strict?: boolean;
}

export type ToolCall = { id: string; name: string; payload: any; type?: string };

export type ProviderResponse =
  | { kind: "assistant"; messages: Msg[]; raw?: any }
  | { kind: "tool_calls"; calls: ToolCall[]; raw?: any }
  | { kind: "mixed"; messages: Msg[]; calls: ToolCall[]; raw?: any };
