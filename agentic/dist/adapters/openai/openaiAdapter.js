const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
    console.error("Missing OPENAI_API_KEY in your environment.");
    process.exit(1);
}
// ---- HTTP helpers ----
export async function openaiCreateResponse(body) {
    const r = await fetch(`${BASE}/v1/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok)
        throw new Error(`createResponse ${r.status}: ${text}`);
    return JSON.parse(text);
}
export async function createConversation() {
    const r = await fetch(`${BASE}/v1/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    const text = await r.text();
    if (!r.ok)
        throw new Error(`createConversation ${r.status}: ${text}`);
    const j = JSON.parse(text);
    if (!j?.id || !String(j.id).startsWith("conv_"))
        throw new Error(`createConversation unexpected id: ${j?.id}`);
    return j.id;
}
// ---- Response parsing (1:1 with your monolith) ----
export function extractAssistantText(resp) {
    let buf = "";
    for (const o of resp.output ?? []) {
        if (o.type === "message" && o.role === "assistant") {
            for (const c of o.content ?? []) {
                if (c.type === "output_text")
                    buf += c.text + "\n";
            }
        }
    }
    return buf.trim();
}
export function extractToolCalls(resp) {
    const calls = [];
    for (const o of resp.output ?? []) {
        if (o.type === "function_call") {
            const args = typeof o.arguments === "string" ? safeJsonParse(o.arguments) : (o.arguments || {});
            calls.push({ id: o.call_id || o.id, name: o.name, payload: args, type: o.type });
        }
    }
    return calls;
}
function safeJsonParse(s) { try {
    return JSON.parse(s);
}
catch {
    return s;
} }
// ---- Request builder (keeps your shape) ----
export function buildRequest(opts) {
    return {
        model: opts.model,
        conversation: opts.conversation,
        input: opts.messages.map(m => ({ role: m.role, content: m.content, name: m.name })),
        tools: opts.tools,
        temperature: opts.temperature ?? 0.2,
        parallel_tool_calls: opts.parallel_tool_calls ?? true,
    };
}
