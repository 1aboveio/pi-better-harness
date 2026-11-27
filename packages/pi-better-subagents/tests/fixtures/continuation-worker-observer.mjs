import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { splitNativeFraming } from "../../../pi-better-server/test/support/native-message-framing.mjs";

// Observe real CLI inputs and native history. This fixture never creates or appends a session.
const argv = process.argv.slice(2);
if (process.argv[1]?.endsWith("managed-worker.mjs") && process.env.PI_CONTINUATION_ARTIFACTS) {
    const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
    const sessionPath = option("--session"), sessionDir = option("--session-dir"), sessionId = option("--session-id");
    const messages = path => {
        const native = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "message");
        const { framing } = splitNativeFraming(native.map(entry => ({ role: entry.message.role,
            text: typeof entry.message.content === "string" ? entry.message.content : (entry.message.content ?? []).map(block => block.text ?? "").join("") })));
        return native.slice(framing.length);
    };
    const before = sessionPath && existsSync(sessionPath) ? messages(sessionPath).length : 0;
    let recorded = false;
    const record = () => {
        if (recorded) return;
        const path = sessionPath ?? readdirSync(sessionDir).map(name => join(sessionDir, name)).find(path => {
            try { return JSON.parse(readFileSync(path, "utf8").split("\n")[0]).id === sessionId; } catch { return false; }
        });
        if (!path) return;
        const entries = messages(path), header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]);
        writeFileSync(join(process.env.PI_CONTINUATION_ARTIFACTS, `${process.pid}.json`), JSON.stringify({
            pid: process.pid, argv, sessionPath: sessionPath ?? null, sessionDir, sessionId: sessionId ?? null,
            prompt: argv.at(-1), sessionFile: path, sessionIdAfter: header.id, before, after: entries.length,
            answer: entries.filter(entry => entry.message.role === "assistant").at(-1)?.message.content?.map(block => block.text ?? "").join(""),
        }));
        recorded = true;
    };
    process.once("beforeExit", () => {
        record();
        const key = createHash("sha256").update(argv.at(-1)).digest("hex");
        const path = join(process.env.PI_CONTINUATION_ARTIFACTS, `control-${key}.json`);
        const hold = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).holdAfterWriteMs : 0;
        if (hold) setTimeout(() => {}, hold);
    });
    process.once("exit", record);
}
