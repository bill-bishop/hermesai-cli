import chalk from "chalk";
export const TRUNCATE_LIMIT = 5000;
export const TRUNCATE_TO_FIRST_LINE = false;
export function safeJsonParse(s) { try {
    return JSON.parse(s);
}
catch {
    return s;
} }
export function asString(v) { return typeof v === "string" ? v : JSON.stringify(v); }
export function oneLine(str) {
    if (!str)
        return "";
    const line = String(str).split(/\r?\n/)[0] || "";
    return line.trim();
}
export function truncateOneLine(str, n = TRUNCATE_LIMIT) {
    const line = TRUNCATE_TO_FIRST_LINE ? oneLine(str) : str;
    return line.length > n ? line.slice(0, n) + chalk.gray(" ...") : line;
}
export function indent(level) { return "  ".repeat(level); }
export function colorAgent(name) {
    const base = String(name).replace(/^[^A-Za-z]+/, "");
    if (/coding|coder|code agent/i.test(base))
        return chalk.blueBright(name);
    if (/planning|planner|plan agent/i.test(base))
        return chalk.yellow(name);
    if (/delegation|delegator/i.test(base))
        return chalk.magentaBright(name);
    if (/user/i.test(base))
        return chalk.cyanBright(name);
    return chalk.whiteBright(name);
}
export function pushTranscript(transcripts, agentLabel, text) {
    if (!text)
        return;
    transcripts.push({ agent: agentLabel, text });
}
