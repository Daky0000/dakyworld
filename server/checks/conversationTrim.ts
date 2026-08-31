/**
 * Letting go of old tool answers, without breaking the two things that would
 * make it worse than doing nothing.
 *
 * A turn re-sends everything before it, so a tool result read on turn two is
 * still being paid for on turn twelve. `clipToolResult` caps any single answer;
 * `releaseOldAnswers` caps the pile of them. Both of the ways this goes wrong
 * are silent:
 *
 *  - **Deleting a message would break the conversation outright.** A `tool_use`
 *    separated from its `tool_result` is rejected by the API, so the block, its
 *    id and its position all have to survive — only the text goes. The same
 *    rule `saveCheckpoint`'s `trimToFit` follows, and the reason it is a rule.
 *  - **Trimming on every turn would cost more than it saves.** The prompt cache
 *    is keyed on an exact prefix; rewriting the front of the conversation every
 *    turn means paying full input rate for all of it, every turn. Hence two
 *    numbers — fire at the ceiling, cut back well below it — and hence the
 *    assertion that a second call in a row does nothing.
 *
 * No database, no key, no network.
 */
import { releaseOldAnswers } from "../src/lib/claudeAgent.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

type Message = { role: "user" | "assistant"; content: unknown };

/** A conversation of `turns` tool calls, each answered with `size` characters. */
function conversation(turns: number, size: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `call_${i}`, name: "lead__read", input: { id: `lead-${i}` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: "x".repeat(size) }],
    });
  }
  return messages;
}

const idsIn = (messages: Message[]) => {
  const ids: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as { type?: string; id?: string; tool_use_id?: string }[]) {
      if (block.type === "tool_use" && block.id) ids.push(`use:${block.id}`);
      if (block.type === "tool_result" && block.tool_use_id) ids.push(`result:${block.tool_use_id}`);
    }
  }
  return ids;
};

console.log("\nA small conversation is left alone");
{
  const messages = conversation(4, 500);
  const before = JSON.stringify(messages);
  const released = releaseOldAnswers(messages as never);
  check("nothing is released", released === 0, `${released}`);
  check("and not a byte changes", JSON.stringify(messages) === before);
}

console.log("\nA large one loses its oldest answers");
{
  const messages = conversation(40, 5_000);
  const idsBefore = idsIn(messages);
  const sizeBefore = JSON.stringify(messages).length;

  const released = releaseOldAnswers(messages as never);
  const sizeAfter = JSON.stringify(messages).length;

  check("something is released", released > 0, `${released}`);
  check("and it is actually smaller", sizeAfter < sizeBefore, `${sizeBefore} → ${sizeAfter}`);

  // The rule that keeps the conversation sendable. Every `tool_use` must still
  // have its `tool_result` in place, in order — a pair broken here is a 400
  // from the vendor on the next turn, not a slightly larger bill.
  check("every call still has its answer, in the same order", JSON.stringify(idsIn(messages)) === JSON.stringify(idsBefore), idsIn(messages).slice(0, 6).join(", "));
  check("no message was dropped", messages.length === 80, `${messages.length}`);

  // Oldest first: the recent turns are what the model is still reasoning from.
  const first = (messages[1].content as { content?: unknown }[])[0].content as string;
  const last = (messages[79].content as { content?: unknown }[])[0].content as string;
  check("the oldest answer is the one let go of", first.startsWith("[This answer has been let go of"), first.slice(0, 40));
  check("and the newest is untouched", last.startsWith("xxxx"), last.slice(0, 40));

  // An answer that was released says so rather than appearing to be a short
  // answer — the same reason `clipToolResult` says when it has cut.
  check("and it says what happened to it", first.includes("call the tool again"), first.slice(0, 120));

  console.log("\nAnd does not fire again on the next turn");
  {
    // The cache property. A second pass immediately afterwards must find the
    // conversation already small enough, or every turn rewrites the prefix and
    // the whole thing costs more than it saves.
    const again = releaseOldAnswers(messages as never);
    check("a second pass releases nothing", again === 0, `${again}`);
  }
}

console.log("\nA conversation of nothing but huge answers still terminates");
{
  // The pathological case: every answer released and still over the ceiling.
  // It must run out of things to release and return, not loop.
  const messages = conversation(2, 400_000);
  const released = releaseOldAnswers(messages as never);
  check("it releases what it can and stops", released === 2, `${released}`);
  check("and the pairs survive even then", idsIn(messages).length === 4, idsIn(messages).join(", "));
}

console.log(bad ? `\n${bad} PROBLEM(S)` : `\nOld answers are let go of once, not every turn, and the conversation stays sendable.`);
process.exitCode = bad ? 1 : 0;
