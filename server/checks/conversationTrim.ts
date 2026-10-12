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
 * The same two rules hold for `compactOldToolResults`, the gentler step that
 * shortens older answers before any are let go of, which used to run on every
 * turn and was in no check at all. And three more that are about what the
 * model is told rather than what it costs: a clipped answer clipped again must
 * still say how long it really was; the newest results — the ones the model
 * has not read — are never released; and nothing above a thinking block is
 * ever rewritten, because Claude's newer models sign their reasoning against
 * everything sent before it.
 *
 * No database, no key, no network.
 */
import { clipToolResult, compactOldToolResults, releaseOldAnswers, TOOL_RESULT_MAX_CHARS } from "../src/lib/claudeAgent.js";
import { trimToFit } from "../src/services/agents/checkpoint.js";
import { prisma } from "../src/lib/prisma.js";

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
  // The pathological case: everything it may release released and still over
  // the ceiling. It must run out of things to release and return, not loop —
  // and the newest answer is not one of the things it may release, however
  // large: the model has not read it yet.
  const messages = conversation(2, 400_000);
  const newest = JSON.stringify(messages[3]);
  const released = releaseOldAnswers(messages as never);
  check("it releases what it can and stops", released === 1, `${released}`);
  check("the newest answer is kept, unread as it is", JSON.stringify(messages[3]) === newest, JSON.stringify(messages[3]).slice(0, 80));
  check("and the pairs survive even then", idsIn(messages).length === 4, idsIn(messages).join(", "));
  check("a second pass finds nothing left to release", releaseOldAnswers(messages as never) === 0);
}

console.log("\nThe answers the model has not read yet are never let go of");
{
  // A long brief and one turn of large answers can cross the ceiling on their
  // own. Releasing then took the results the model was about to see and told
  // it "you read it at the time", which it had not.
  const messages: Message[] = [{ role: "user", content: "b".repeat(30_000) }, ...conversation(3, 9_000)];
  const unread = JSON.stringify(messages[messages.length - 1]);
  const idsBefore = idsIn(messages);
  const released = releaseOldAnswers(messages as never);
  check("the conversation was over the ceiling, so something went", released > 0, `${released}`);
  check("the final user turn is byte for byte what it was", JSON.stringify(messages[messages.length - 1]) === unread);
  check("every call still has its answer, in order", JSON.stringify(idsIn(messages)) === JSON.stringify(idsBefore));
  check("and a second pass releases nothing", releaseOldAnswers(messages as never) === 0);
}

console.log("\nA clipped answer clipped again still says how long it was");
{
  // The runner clips a catalogue tool's output and the loop clips every result
  // again. The second pass used to cut the first notice off and report the
  // clipped length — so the model was told a 50,000-character answer had been
  // 6,237 characters, which is the one number the notice exists to get right.
  const once = clipToolResult("x".repeat(50_000));
  const twice = clipToolResult(once);
  check("clipping twice is clipping once", twice === once, `${once.length} → ${twice.length}`);
  check("the notice names the true length", twice.includes("50,000"), twice.slice(-260));
  check("and the whole thing stays under a page and a half", twice.length < 6_400, String(twice.length));
  check("an answer under the ceiling is untouched", clipToolResult("short") === "short");
  // A clip made at a larger ceiling is cut again, and still names the original.
  const wide = clipToolResult("y".repeat(50_000), TOOL_RESULT_MAX_CHARS * 2);
  const narrowed = clipToolResult(wide);
  check("a wider clip cut to the ceiling keeps the true length", narrowed.includes("50,000") && narrowed.length < 6_400, narrowed.slice(-260));
}

/** A tool_result's text, at a message index. */
const resultAt = (messages: Message[], index: number) => String((messages[index].content as { content?: unknown }[])[0]?.content ?? "");

console.log("\nOlder answers are shortened only past the soft ceiling");
{
  const messages = conversation(4, 500);
  const before = JSON.stringify(messages);
  check("a small conversation is not shortened", compactOldToolResults(messages as never) === 0);
  check("and not a byte changes", JSON.stringify(messages) === before);
}

console.log("\nPast it, everything eligible is shortened at once");
{
  const messages = conversation(10, 3_000);
  // An error answer in the eligible range. A refusal is information the model
  // needs to keep, and it is short anyway.
  (messages[5].content as { is_error?: boolean }[])[0].is_error = true;
  const errorBefore = JSON.stringify(messages[5]);
  const tailBefore = JSON.stringify(messages.slice(-4));
  const idsBefore = idsIn(messages);

  const shortened = compactOldToolResults(messages as never);
  check("every eligible answer went in one pass", shortened === 7, `${shortened} (eight old answers, one of them an error)`);
  check("the last four messages are untouched", JSON.stringify(messages.slice(-4)) === tailBefore);
  check("an error answer is never shortened", JSON.stringify(messages[5]) === errorBefore);
  check("every call still has its answer, in order", JSON.stringify(idsIn(messages)) === JSON.stringify(idsBefore));
  const stub = resultAt(messages, 1);
  check("the stub says how long the answer was", stub.startsWith("[Shortened from 3,000 characters; first 260 kept."), stub.slice(0, 90));
  check("and keeps the opening of it", stub.endsWith("x".repeat(260)), stub.slice(-20));
  check("and never claims anything was extracted from it", !JSON.stringify(messages).includes("extracted"));
  check("a second pass shortens nothing", compactOldToolResults(messages as never) === 0);
}

console.log("\nA large tail keeps it over the ceiling, and it still does not fire twice");
{
  // The protected tail alone is over the soft ceiling, so the conversation is
  // still too big after shortening. A second pass must find nothing left to
  // shorten rather than eat into the turns the model is reasoning from.
  const messages = [...conversation(6, 2_000), ...conversation(2, 15_000).map((message, index) => ({
    ...message,
    content: (message.content as Record<string, unknown>[]).map((block) =>
      block.type === "tool_use" ? { ...block, id: `tail_${index}` } : { ...block, tool_use_id: `tail_${index - 1}` },
    ),
  }))];
  const first = compactOldToolResults(messages as never);
  check("the first pass shortened the old answers", first === 6, String(first));
  check("still over the ceiling", JSON.stringify(messages).length > 24_000, String(JSON.stringify(messages).length));
  check("and a second pass shortens nothing", compactOldToolResults(messages as never) === 0);
}

console.log("\nNothing above a thinking block is rewritten");
{
  // Claude's newer models sign each thinking block against everything sent
  // before it. Rewriting a result above one invalidates that reasoning, and on a
  // newer account turns the next request into a 400 — so on a run Claude has
  // thought in, the conversation stays append-only.
  const thought = (messages: Message[], index: number) => {
    messages[index] = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Weighing it up.", signature: `sig_${index}` }, ...(messages[index].content as unknown[])],
    };
  };

  const latest = conversation(40, 5_000);
  thought(latest, 78);
  const before = JSON.stringify(latest);
  check("with thinking in the newest turn, nothing is shortened", compactOldToolResults(latest as never) === 0);
  check("and nothing is released", releaseOldAnswers(latest as never) === 0);
  check("not a byte changed", JSON.stringify(latest) === before);

  // Thinking part-way through: only what comes after it may change.
  const middle = conversation(40, 5_000);
  thought(middle, 40);
  const head = JSON.stringify(middle.slice(0, 41));
  const released = releaseOldAnswers(middle as never);
  check("after the thinking block, old answers can still go", released > 0, String(released));
  check("everything up to and including it is untouched", JSON.stringify(middle.slice(0, 41)) === head);
  const shortened = compactOldToolResults(middle as never);
  check("the same holds for shortening", JSON.stringify(middle.slice(0, 41)) === head, `${shortened} shortened`);
}

console.log("\nAnd the same rule again, one layer down, on what is written to the row");
{
  // `trimToFit` is the checkpoint's own ceiling. It runs after every model turn
  // *and* every tool call, so it is the cheapest thing here that is paid for
  // most often — which is why it measures before it copies, and subtracts each
  // trim from a running total rather than re-serialising the whole conversation
  // once per block. Both of those are only safe if it still leaves the caller's
  // own messages alone, so that is what is asserted.
  const small = conversation(2, 100);
  const before = JSON.stringify(small);
  const kept = trimToFit(small as never);
  check("a conversation under the ceiling comes back whole", JSON.stringify(kept) === before);
  check("and the caller's own copy is untouched", JSON.stringify(small) === before);

  const big = conversation(30, 400_000);
  const bigBefore = JSON.stringify(big);
  const trimmed = trimToFit(big as never) as unknown as Message[];
  const size = JSON.stringify(trimmed).length;
  check("a conversation over it comes back under it", size <= 3_000_000, String(size));
  // The one that would corrupt a run rather than merely waste one: the loop is
  // still holding these messages, and writing the row must not reach into them.
  check("and the live conversation is still the live conversation", JSON.stringify(big) === bigBefore);
  check("no message was dropped", trimmed.length === big.length, String(trimmed.length));
  check("every call still has its answer", idsIn(trimmed as never).length === 60, String(idsIn(trimmed as never).length));

  // Oldest first, so the turns the model is actually still reasoning from are
  // the ones that survive.
  const answers = trimmed
    .filter((message) => message.role === "user")
    .map((message) => String((message.content as { content?: unknown }[])[0]?.content ?? ""));
  check("the oldest answer is the one let go of", answers[0].startsWith("[This result was trimmed"), answers[0].slice(0, 40));
  check("and the newest is untouched", answers[answers.length - 1].length > 1000, String(answers[answers.length - 1].length));
}

await prisma.$disconnect();

console.log(bad ? `\n${bad} PROBLEM(S)` : `\nOld answers are let go of once, not every turn, and the conversation stays sendable.`);
process.exitCode = bad ? 1 : 0;
