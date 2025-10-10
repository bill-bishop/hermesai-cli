#!/usr/bin/env node
// HermesAI MVP — Interactive CLI (ESM, SDK-free, structured logs)
// - Subagents each in their own conversation (prevents pending-tool deadlocks)
// - Recursive orchestration: User -> Delegation -> (Plan -> Code)
// - First-line-only truncation (50 chars) for step logs
// - Subagents run quiet; final pretty summaries for all agents then User Agent

import readline from "readline";
import chalk from "chalk";

// ----- START HERMES AI TOOLS -----
import { eztree } from '@hermesai/eztree';
// ----- END HERMES AI TOOLS -----

import fs from "fs";
import path from "node:path";

const {promisify} = await import('util');
const {exec: execCallback} = await import('child_process');
const exec = promisify(execCallback);
const { stdin: input, stdout: output } = process;

// ───────────── Config ─────────────
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
    console.error("Missing OPENAI_API_KEY in your environment.");
    process.exit(1);
}
const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com";

const TRUNCATE_LIMIT = 5000;
const TRUNCATE_TO_FIRST_LINE = false;

// ───────────── Utilities ─────────────
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return s; } }
function asString(v) { return typeof v === "string" ? v : JSON.stringify(v); }

// First line only, then truncate to n chars
function oneLine(str) {
    if (!str) return "";
    const line = String(str).split(/\r?\n/)[0] || "";
    return line.trim();
}
function truncateOneLine(str, n = TRUNCATE_LIMIT) {
    const line = TRUNCATE_TO_FIRST_LINE ? oneLine(str) : str;
    return line.length > n ? line.slice(0, n) + chalk.gray(" ...") : line;
}

// Simple spaces for indentation (Windows-friendly)
function indent(level) { return "  ".repeat(level); }

// Robust color mapper (ignores leading symbols like "■ ")
function colorAgent(name) {
    const base = String(name).replace(/^[^A-Za-z]+/, "");
    if (/coding|coder|code agent/i.test(base)) return chalk.blueBright(name);       // Coding = red
    if (/planning|planner|plan agent/i.test(base)) return chalk.yellow(name); // Planning = yellow
    if (/delegation|delegator/i.test(base)) return chalk.magentaBright(name);     // Delegation = magenta
    if (/user/i.test(base)) return chalk.cyanBright(name);                        // User = cyan
    return chalk.whiteBright(name);
}

function pushTranscript(transcripts, agentLabel, text) {
    if (!text) return;
    transcripts.push({ agent: agentLabel, text });
}

// ───────────── HTTP helpers ─────────────
async function openaiCreateResponse(body) {
    const r = await fetch(`${BASE}/v1/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`createResponse ${r.status}: ${text}`);
    return JSON.parse(text);
}
async function createConversation() {
    const r = await fetch(`${BASE}/v1/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`createConversation ${r.status}: ${text}`);
    const j = JSON.parse(text);
    if (!j?.id || !String(j.id).startsWith("conv_")) throw new Error(`createConversation unexpected id: ${j?.id}`);
    return j.id;
}

// ───────────── Response parsing ─────────────
function extractAssistantText(resp) {
    let buf = "";
    for (const o of resp.output ?? []) {
        if (o.type === "message" && o.role === "assistant") {
            for (const c of o.content ?? []) {
                if (c.type === "output_text") buf += c.text + "\n";
            }
        }
    }
    return buf.trim();
}
function extractToolCalls(resp) {
    const calls = [];
    for (const o of resp.output ?? []) {
        if (o.type === "function_call") {
            const args = typeof o.arguments === "string" ? safeJsonParse(o.arguments) : (o.arguments || {});
            calls.push({ id: o.call_id || o.id, name: o.name, payload: args });
        }
    }
    return calls;
}

// ───────────── System prompts ─────────────
const USER_AGENT_SYS = `
You are the User-Facing Agent for HermesAI.
Clarify requirements and, once ready, call delegate() with a concise task_brief.
Be pragmatic and concise.
`.trim();

const DELEGATOR_SYS = `
You are the Delegation Agent.
You never code yourself; you orchestrate:
1) plan() -> actionable, ordered plan to scaffold project, install dependencies, and make or alter specific files
2) For EACH code scaffolding/install/build/run step in the plan, call exec() exactly once with:
   - cmd: Ubuntu shell instruction
   - cwd: the project-relative file path where the instruction will be executed
3) For EACH file in the plan, call code() exactly once with:
   - task_brief: a precise, single-file instruction
   - output_path: the project-relative file path that will receive the code
4) After all steps are handled, return a final handoff summary
`.trim();


const PLANNING_SYS = `
You are the Planning Agent.
Before constructing the plan, call readfile() to inspect any project files that will be changed

Then search the web to check:
- Latest stable versions of all relevant dependencies/frameworks
- Official docs (installation, quickstart, production notes)
- Any common pitfalls or deployment gotchas

Then produce a concrete, implementable plan with step-by-step milestones:
- Assumptions, risks, unknowns
- Citations for any web searches used
- Ordered list of code-scaffolding/install/build/run steps, interleaved with file-specific creation/alteration steps
`.trim();


const CODING_SYS = `
You are the Coding Agent.
Output minimal code and integration notes. No execution.
`.trim();

// ───────────── Tool descriptors ─────────────
const tool_delegate = {
    type: "function",
    name: "delegate",
    description: "Hand off a clarified task to the Delegation agent.",
    parameters: { type: "object", properties: { task_brief: { type: "string" } }, required: ["task_brief"] },
    strict: false,
};
const tool_plan = {
    type: "function",
    name: "plan",
    description: "Ask Planning agent for a plan and references.",
    parameters: { type: "object", properties: { task_brief: { type: "string" } }, required: ["task_brief"] },
    strict: false,
};
const tool_code = {
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
const tool_exec = {
    type: "function",
    name: "exec",
    description: "Execute Ubuntu shell commands",
    parameters: {
        type: "object",
        properties: {
            cmd: { type: "string", "description": "the shell command to execute" },
            cwd: { type: "string", "description": "the relative path where the command should be executed" },
        },
        required: ["cmd"]
    },
    strict: false,
};
const tool_readfile = {
    type: "function",
    name: "readfile",
    description: "Read project file contents",
    parameters: {
        type: "object",
        properties: {
            filePath: { type: "string", "description": "the relative path to the file"},
        },
        required: ["filePath"],
    },
    strict: false,
};


// ───────────── Recursive Runner ─────────────
/**
 * runWithTools: one agent turn with tools, in its own conversation
 * Params:
 *  - model, system, userInput, tools, agentLabel
 *  - depth: recursion depth (indent)
 *  - ctx: shared state across recursion (e.g., lastPlanSummary)
 *  - transcripts: array collecting {agent, text} for all agents
 *  - collectUser: array to push top-level User Agent output_text (for final print)
 *  - quiet: if true, suppress assistant draft logs for this agent (subagents use quiet)
 */
async function runWithTools({
                                model,
                                system,
                                userInput,
                                tools,
                                agentLabel,
                                depth = 0,
                                ctx = { lastPlanSummary: "" },
                                transcripts = [],
                                collectUser = null,
                                quiet = false,
                            }) {
    const convId = await createConversation();
    const prefix = indent(depth);
    console.log(`${prefix}${colorAgent(agentLabel)}  (${chalk.gray(convId)})`);
    console.log(`${prefix}- ${truncateOneLine(userInput || "")}`);

    let resp = await openaiCreateResponse({
        model,
        conversation: convId,
        input: [
            { role: "system", content: system },
            ...(userInput ? [{ role: "user", content: userInput }] : []),
        ],
        tools,
        temperature: 0.2,
        parallel_tool_calls: true,
    });

    while (true) {
        const text = extractAssistantText(resp);
        if (text) {
            pushTranscript(transcripts, agentLabel, text);
            if (!quiet) {
                console.log(`${prefix}  . ${truncateOneLine(text)}`);
            }
            if (collectUser && depth === 0) collectUser.push(text);
        }

        const calls = extractToolCalls(resp);
        if (!calls.length) {
            if (resp.status === "completed") {
                console.log(`${prefix}Completed`);
                return text || "[No text]";
            }
            await new Promise((r) => setTimeout(r, 100));
            continue;
        }

        console.log(`${prefix}  . ${calls.length} tool call(s):`);
        console.log(`${prefix} \t\t ${calls.map(({payload}) => JSON.stringify(payload)).join(' . ')}`)
        const outputs = [];
        for (const c of calls) {
            const name = c.name;
            const brief = c.payload?.task_brief || "";
            console.log(`${prefix}  -> ${chalk.bold(name)} ${chalk.dim(truncateOneLine(brief))}`);

            let out = "";
            try {
                if (name === "delegate") {
                    out = await runWithTools({
                        model: "gpt-4.1-mini",
                        system: DELEGATOR_SYS,
                        userInput: `Task: ${brief}`,
                        tools: [tool_plan, tool_code, tool_exec],
                        agentLabel: "Delegation Agent",
                        depth: depth + 1,
                        ctx,
                        transcripts,
                        quiet: true,
                    });
                } else if (name === "plan") {
                    const projectStructure = eztree('.') || '(tree generation error)';
                    out = await runWithTools({
                        model: "gpt-4.1",
                        system: PLANNING_SYS,
                        userInput: `Current project structure:
${projectStructure}

Plan for: ${brief}`,
                        tools: [tool_readfile],
                        agentLabel: "Planning Agent",
                        depth: depth + 1,
                        ctx,
                        transcripts,
                        quiet: true,
                    });
                    ctx.lastPlanSummary = out.slice(0, 1000);
                } else if (name === "code") {
                    const outPath = path.resolve(c.payload?.output_path) || "(unspecified)";
                    const briefOnly = c.payload?.task_brief || brief;

                    const currentFile = String(await fs.promises.readFile(outPath)).trim() || '(none)';

                    out = await runWithTools({
                        model: "gpt-4.1",
                        system: CODING_SYS,
                        userInput: `Target file: ${outPath}
Target file current content:\n\n${currentFile}\n\n              
Task: ${briefOnly}
Plan Summary: ${ctx.lastPlanSummary}

Return RAW code only (no fences, no prose).`,
                        tools: [],
                        agentLabel: "Coding Agent",
                        depth: depth + 1,
                        ctx,
                        transcripts,
                        quiet: true,
                    });

                    await fs.promises.mkdir(path.dirname(outPath), {recursive: true});
                    await fs.promises.writeFile(outPath, out);
                }
                else if (name === "exec") {
                    const cmd = c.payload.cmd;
                    const cwd = path.resolve(c.payload?.cwd || '.');

                    try {
                        const {stdout, stderr} = await exec(cmd, {cwd});

                        out = stdout || stderr;
                    } catch (error) {
                        out = `Shell error: ${error.message}`;
                    }

                }
                else if (name === "readfile") {
                    const filePath = path.resolve(c.payload.filePath);

                    try {
                        const currentFile = String(await fs.promises.readFile(filePath)).trim() || '(no file contents present)';
                        out = currentFile;
                    } catch (error) {
                        out = `Readfile error: ${error.message}`;
                    }

                }
                else {
                    out = `[Tool ${name} not implemented]`;
                }
            } catch (err) {
                out = `Error: ${err.message}`;
            }

            outputs.push({ type: "function_call_output", call_id: c.id, output: asString(out) });
            console.log(`${prefix}  <- done ${chalk.dim(name)} (${truncateOneLine(out)})`);
        }

        // Return tool outputs to resolve pending calls in this conversation
        resp = await openaiCreateResponse({
            model,
            conversation: convId,
            input: outputs,
            tools,
            temperature: 0.2,
            parallel_tool_calls: true,
        });
    }
}

// ───────────── Top-level User Agent wrapper ─────────────
async function runUserAgent(text) {
    const ready = /\b(demo|done|hello world|ship|go ahead)\b/i.test(text || "");
    const hint = ready ? "\n[User ready — delegate]" : "";
    const collectedUser = [];   // gather top-level User Agent output_text
    const transcripts = [];     // gather all agents' output_text

    await runWithTools({
        model: "gpt-4.1-mini",
        system: USER_AGENT_SYS,
        userInput: (text || "") + hint,
        tools: [tool_delegate],
        agentLabel: "User Agent",
        collectUser: collectedUser,
        transcripts,
    });

    // Pretty summary: first all sub-agents (non-user), then the user-facing
    const nonUser = transcripts.filter(t => t.agent !== "User Agent");
    if (nonUser.length) {
        console.log(chalk.gray("\n--------------------------------------------"));
        console.log(chalk.bold("Agents Output (summary)\n"));
        // Group by agent
        const byAgent = nonUser.reduce((acc, cur) => {
            (acc[cur.agent] ||= []).push(cur.text);
            return acc;
        }, {});
        for (const agent of Object.keys(byAgent)) {
            console.log(colorAgent(`■ ${agent}`));
            console.log(byAgent[agent].map(s => truncateOneLine(s)).join("\n"));
            console.log(""); // spacing
        }
        console.log(chalk.gray("--------------------------------------------"));
    }

    if (collectedUser.length) {
        console.log(chalk.bold.cyan("\nUser-Facing Agent Output:\n"));
        console.log(collectedUser.join("\n\n"));
        console.log(chalk.gray("\n--------------------------------------------\n"));
    }
}

// ───────────── CLI ─────────────
async function interactiveLoop(initial) {
    console.log(chalk.bold("\nHermesAI MVP — Interactive Mode (Ctrl+C to exit)\n"));
    if (initial) await runUserAgent(initial);

    const rl = readline.createInterface({ input, output, prompt: chalk.gray("You> ") });
    rl.prompt();

    rl.on("line", async (line) => {
        const text = line.trim();
        if (!text) return rl.prompt();
        try { await runUserAgent(text); }
        catch (err) { console.error(chalk.red(`Error: ${err.message}`)); }
        rl.prompt();
    });

    rl.on("close", () => { console.log("\nGoodbye!"); process.exit(0); });
}

// ───────────── Entry ─────────────
const seed = process.argv.slice(2).join(" ").trim() || null;
await interactiveLoop(seed);
