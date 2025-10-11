#!/usr/bin/env node
import readline from "readline";
import chalk from "chalk";
import fs from "fs";
import path from "node:path";
import { promisify } from "node:util";
import { exec as execCallback } from "node:child_process";

// HermesAI tools
import { eztree } from "@hermesai/eztree";

// Core helpers
import { indent, truncateOneLine, colorAgent, pushTranscript, asString } from "../core/util";
import { resolveInsideRoot } from "../core/path";
import type { Msg } from "../core/types";

// OpenAI adapter bits
import { createConversation, openaiCreateResponse, extractAssistantText, extractToolCalls, buildRequest } from "../adapters/openai/openaiAdapter";
import { USER_AGENT_SYS, DELEGATOR_SYS, PLANNING_SYS, CODING_SYS } from "../adapters/openai/prompts";
import { tool_delegate, tool_plan, tool_code, tool_exec, tool_readfile } from "../adapters/openai/tools";

const execp = promisify(execCallback);
const { stdin: input, stdout: output } = process;

const projectStructure = (eztree('.') || '(tree generation error)').split('\n').subarray(0, 50).join('\n');

// ───────────── Recursive Runner ─────────────
async function runWithTools({
  model,
  system,
  userInput,
  tools,
  agentLabel,
  depth = 0,
  ctx = { lastPlanSummary: "" as string },
  transcripts = [] as Array<{agent:string; text:string}>,
  collectUser = null as string[] | null,
  quiet = false,
}) {
  const convId = await createConversation();
  const prefix = indent(depth);
  console.log(`${prefix}${colorAgent(agentLabel)}  (${chalk.gray(convId)})`);
  console.log(`${prefix}- ${truncateOneLine(userInput || "")}`);

  let resp = await openaiCreateResponse(buildRequest({
    model,
    conversation: convId,
    messages: [
      { role: "system", content: system },
      ...(userInput ? [{ role: "user", content: userInput } as Msg] : []),
    ],
    tools,
    temperature: 0.2,
    parallel_tool_calls: true,
  }));

  while (true) {
    const text = extractAssistantText(resp);
    if (text) {
      pushTranscript(transcripts, agentLabel, text);
      if (!quiet) console.log(`${prefix}  . ${truncateOneLine(text)}`);
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
    console.log(`${prefix} \t\t ${calls.map(({payload}) => JSON.stringify(payload)).join(' . ')}`);
    const outputs: any[] = [];

    for (const c of calls) {
      const name = c.name;
      const brief = c.payload?.task_brief || "";
      console.log(`${prefix}  -> ${chalk.bold(name)} ${chalk.dim((brief||'').split(/\r?\n/)[0].slice(0,50))}`);

      let out = "";
      try {
        if (name === "delegate") {
          out = await runWithTools({
            model: "gpt-4.1-mini",
            system: DELEGATOR_SYS,
            userInput: `Current project structure:
${projectStructure}

Task: ${brief}`,
            tools: [tool_plan, tool_code, tool_exec],
            agentLabel: "Delegation Agent",
            depth: depth + 1,
            ctx,
            transcripts,
            quiet: true,
          });
        } else if (name === "plan") {
          out = await runWithTools({
            model: "gpt-4.1",
            system: PLANNING_SYS,
            userInput: `Current project structure:
${projectStructure}

Plan for: ${brief}`,
            tools: [tool_readfile, { type: 'web_search', name: 'web_search', parameters: {} } as any],
            agentLabel: "Planning Agent",
            depth: depth + 1,
            ctx,
            transcripts,
            quiet: true,
          });
          ctx.lastPlanSummary = out.slice(0, 1000);
        } else if (name === "code") {
          const { abs, rel } = await resolveInsideRoot(c.payload?.output_path);
          const outPath =  rel || "(unspecified)";
          const briefOnly = c.payload?.task_brief || brief;

          const currentFile = String(await fs.promises.readFile(abs).catch(() => "")).trim() || '(none)';

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

          await fs.promises.mkdir(path.dirname(abs), {recursive: true});
          await fs.promises.writeFile(abs, out);
        }
        else if (name === "exec") {
          const { abs } = await resolveInsideRoot(c.payload?.cwd);
          const cmd = c.payload.cmd;
          const cwd = abs;
          try {
            const {stdout, stderr} = await execp(cmd, {cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024});
            out = (stdout || stderr || "").toString();
          } catch (error: any) {
            out = `Shell error: ${error.message}`;
          }
        }
        else if (name === "readfile") {
          const { rel } = await resolveInsideRoot(c.payload.filePath);
          const filePath = path.resolve(rel);
          try {
            const currentFile = String(await fs.promises.readFile(filePath)).trim() || '(no file contents present)';
            out = currentFile;
          } catch (error: any) {
            out = `Readfile error: ${error.message}`;
          }
        }
        else {
          out = `[Tool ${name} not implemented]`;
        }
      } catch (err: any) {
        out = `Error: ${err.message}`;
      }

      outputs.push({ type: "function_call_output", call_id: c.id, output: asString(out) });
      console.log(`${prefix}  <- done ${chalk.dim(name)} (${(out||'').split(/\r?\n/)[0].slice(0,50)})`);
    }

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
async function runUserAgent(text?: string) {
  const ready = /\b(demo|done|hello world|ship|go ahead)\b/i.test(text || "");
  const hint = ready ? "\n[User ready — delegate]" : "";
  const collectedUser: string[] = [];
  const transcripts: Array<{agent:string; text:string}> = [];

  await runWithTools({
    model: "gpt-4.1-mini",
    system: USER_AGENT_SYS,
    userInput: (text || "") + hint,
    tools: [tool_delegate],
    agentLabel: "User Agent",
    collectUser: collectedUser,
    transcripts,
  });

  const nonUser = transcripts.filter(t => t.agent !== "User Agent");
  if (nonUser.length) {
    console.log(chalk.gray("\n--------------------------------------------"));
    console.log(chalk.bold("Agents Output (summary)\n"));
    const byAgent: Record<string,string[]> = nonUser.reduce((acc: any, cur) => {
      (acc[cur.agent] ||= []).push(cur.text);
      return acc;
    }, {});
    for (const agent of Object.keys(byAgent)) {
      console.log(colorAgent(`■ ${agent}`));
      console.log(byAgent[agent].map(s => s.split(/\r?\n/)[0].slice(0,50)).join("\n"));
      console.log("");
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
async function interactiveLoop(initial?: string | null) {
  console.log(chalk.bold("\nHermesAI MVP — Interactive Mode (Ctrl+C to exit)\n"));
  if (initial) await runUserAgent(initial);

  const rl = readline.createInterface({ input, output, prompt: chalk.gray("You> ") });
  rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    try { await runUserAgent(text); }
    catch (err: any) { console.error(chalk.red(`Error: ${err.message}`)); }
    rl.prompt();
  });

  rl.on("close", () => { console.log("\nGoodbye!"); process.exit(0); });
}

// ───────────── Entry ─────────────
const seed = process.argv.slice(2).join(" ").trim() || null;
await interactiveLoop(seed);
