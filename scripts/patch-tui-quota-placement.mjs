import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

// The public status service places every contribution above the prompt. This
// local host patch moves only our key into the existing shrinkable footer row.
const filename = resolve(process.argv[2] ?? `${process.env.DSH_HOME ?? `${homedir()}/.dsh`}/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/screens/Chat.js`);
const statusFilename = resolve(dirname(filename), "StatusLine.js");
const manifest = JSON.parse(await readFile(resolve(dirname(filename), "../../../package.json"), "utf8"));
if (manifest.name !== "@deepseek-harness-tui/dsh-tui" || manifest.version !== "0.14.0") {
  throw new Error("Inline quota placement patch supports dsh-tui 0.14.0 only.");
}
const [chat, status] = await Promise.all([readFile(filename, "utf8"), readFile(statusFilename, "utf8")]);
const marker = 'const codexQuotaText = statusEntries.find';
const statusMarker = "effortPicker, wake, quotaText, activity: projectedActivity,";
if (chat.includes(marker) && status.includes(statusMarker)) {
  console.log("Inline Codex quota placement patch already applied.");
} else {
  function replaceOnce(source, from, to) {
    if (source.split(from).length !== 2) throw new Error("Unexpected TUI layout; patch not applied.");
    return source.replace(from, to);
  }
  let updatedChat = replaceOnce(chat, "    const statusViews = React.useSyncExternalStore", '    const codexQuotaText = statusEntries.find(entry => entry.key === "dsh-codex-oauth:quota")?.text;\n    const abovePromptEntries = statusEntries.filter(entry => entry.key !== "dsh-codex-oauth:quota");\n    const statusViews = React.useSyncExternalStore');
  const above = 'statusEntries.length > 0 && (_jsx(Text, { dimColor: true, wrap: "truncate", children: statusEntries.map(entry => entry.text).join(\' · \') }))';
  updatedChat = replaceOnce(updatedChat, above, above.replaceAll("statusEntries", "abovePromptEntries"));
  updatedChat = replaceOnce(updatedChat, '_jsx(StatusLine, { channel: channel, activity: workingActivity,', '_jsx(StatusLine, { channel: channel, quotaText: codexQuotaText, activity: workingActivity,');
  let updatedStatus = replaceOnce(status, "effortPicker, wake, activity: projectedActivity,", statusMarker);
  updatedStatus = replaceOnce(updatedStatus, "        ...contextParts,", '        ...contextParts,\n        ...(quotaText ? [{ key: "codexQuota", node: _jsx(Text, { dimColor: true, children: quotaText }) }] : []),');
  const changes = [[filename, chat, updatedChat], [statusFilename, status, updatedStatus]];
  for (const [path, original] of changes) await writeFile(`${path}.dsh-codex-oauth.bak`, original, { flag: "wx" });
  // Rename new files rather than modifying pnpm's potentially hard-linked store.
  for (const [path, , updated] of changes) await writeFile(`${path}.dsh-codex-oauth.tmp`, updated);
  for (const [path] of changes) await rename(`${path}.dsh-codex-oauth.tmp`, path);
  console.log("Moved Codex quota into the model/effort footer row; other statuses stay above.");
}
