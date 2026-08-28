import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import {
  mayDecideFromSlack,
  openSlackModal,
  replyToInteraction,
  verifySlackRequest,
} from "../lib/slack.js";
import { ANSWER_VIEW, TASK_ACTIONS } from "../services/agents/escalationCards.js";
import { AnswerRefused, answerTask, answerWithOption, blockedTasks, leaveBlocked, retryTask } from "../services/agents/escalations.js";
import { countPending, listRequests } from "../services/approvals.js";
import { slackHealth } from "../services/slackHealth.js";
import {
  HIRE_ACTIONS,
  HireRefused,
  applyHire,
  declineHire,
  hirePolicy,
  listHireRequests,
  openGaps,
  setHirePolicy,
  withdrawHire,
  type HirePolicy,
} from "../services/agents/hiring.js";
import { ApprovalRefused, approve, decline } from "../services/approvals.js";
import { APPROVAL_ACTIONS, settleApprovalCard } from "../services/approvalCards.js";

/**
 * Slack talking back.
 *
 * Everything else in this app treats Slack as a place to shout at: an alert
 * goes out and nothing comes back. This is the other direction, and it exists
 * because of one question the Owner has to answer repeatedly and at
 * unpredictable times — *should this agent be hired?* — which is exactly the
 * kind of question that dies in an inbox and gets answered instantly from a
 * phone.
 *
 * **Public by necessity, and guarded by one thing.** Slack cannot log in, so
 * this router sits outside `requireAuth` alongside the webhook intake. What
 * protects it is the signing secret: every payload carries an HMAC over the
 * exact bytes sent plus a timestamp, and `verifySlackRequest` refuses anything
 * that does not match, is more than five minutes old, or arrives while no
 * secret is configured. **An unconfigured Slack refuses everything here**,
 * which is the opposite of the outbound rule — failing to send an alert must
 * not break the work, and failing to verify a click must never approve a hire.
 *
 * On top of the signature there is a second, softer check: `SLACK_APPROVERS`.
 * The signature proves the request came from Slack; it does not prove that
 * whoever clicked is allowed to decide. Left blank, anybody who can see the
 * message can click, which is right for a one-person company and wrong the day
 * somebody else joins the channel.
 *
 * **Acknowledged first, worked afterwards.** Slack retries anything it does not
 * hear back from within three seconds, and a retried Approve is a second agent.
 * So every interaction returns 200 immediately and the decision happens behind
 * it, reporting through the `response_url` Slack hands out. That is also why
 * `applyHire` is idempotent about an already-approved request rather than
 * throwing: a duplicate delivery must be a no-op, not an error and not a
 * second row.
 */
export const slackRouter = Router();

/** Slack posts both interactivity and slash commands as urlencoded form data. */
function formFields(raw: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function rawBodyOf(req: Request): string {
  return Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : "";
}

/** Every request here passes the same two checks before anything is read. */
async function authenticate(req: Request, res: Response, kind: string): Promise<string | null> {
  const raw = rawBodyOf(req);
  const check = await verifySlackRequest(req.headers as Record<string, unknown>, raw, kind);
  if (!check.verified) {
    // Logged, because a run of these is either a misconfigured app or somebody
    // probing, and both are worth seeing. Answered with a bare status: an
    // explanation would be a hint.
    console.warn(`[slack] refused an inbound request: ${check.reason}`);
    res.status(check.unconfigured ? 503 : 401).send(check.unconfigured ? "Slack is not configured for inbound requests." : "");
    return null;
  }
  return raw;
}

// --- Buttons ----------------------------------------------------------------

interface BlockAction {
  action_id?: string;
  value?: string;
}

interface Interaction {
  type?: string;
  user?: { id?: string; name?: string };
  response_url?: string;
  trigger_id?: string;
  actions?: BlockAction[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null }>> };
  };
}

slackRouter.post("/actions", async (req, res, next) => {
  try {
    const raw = await authenticate(req, res, "interaction");
    if (raw === null) return;

    const payload = formFields(raw).payload;
    if (!payload) return res.status(400).send("No payload.");

    let interaction: Interaction;
    try {
      interaction = JSON.parse(payload) as Interaction;
    } catch {
      return res.status(400).send("That payload was not JSON.");
    }

    const userId = interaction.user?.id ?? null;
    const who = interaction.user?.name ?? userId ?? "somebody in Slack";

    // Somebody typed an answer into the dialog and pressed Send.
    if (interaction.type === "view_submission") {
      const view = interaction.view;
      if (view?.callback_id !== ANSWER_VIEW.callbackId) return res.status(200).send("");
      const taskId = view.private_metadata ?? "";
      const typed = view.state?.values?.[ANSWER_VIEW.blockId]?.[ANSWER_VIEW.actionId]?.value ?? "";

      // Slack closes the dialog on an empty 200 and shows the error inline on
      // a `response_action`. A refusal has to come back *now*, synchronously,
      // because a dialog that closes on a rejected answer looks exactly like a
      // dialog that accepted it.
      if (!(await mayDecideFromSlack(userId))) {
        return res.json({
          response_action: "errors",
          errors: { [ANSWER_VIEW.blockId]: "You are not on the list of people who can answer these." },
        });
      }
      if (!typed.trim()) {
        return res.json({ response_action: "errors", errors: { [ANSWER_VIEW.blockId]: "An empty answer is not an answer." } });
      }

      res.status(200).send("");
      void answerTask(taskId, typed, { slackUserId: userId, who: `${who} in Slack` }).catch((err) =>
        console.error("[slack] could not answer that task:", (err as Error).message),
      );
      return;
    }

    if (interaction.type !== "block_actions") return res.status(200).send("");

    const action = interaction.actions?.[0];
    const responseUrl = interaction.response_url ?? null;

    // The one thing that cannot wait for the acknowledgement. A `trigger_id`
    // is dead three seconds after the click, so opening the dialog *after*
    // answering Slack means it never opens — and it fails silently, which is
    // the worst shape a failure can have here.
    if (action?.action_id === TASK_ACTIONS.answer && interaction.trigger_id && action.value) {
      if (!(await mayDecideFromSlack(userId))) {
        res.status(200).send("");
        await notAllowed(responseUrl);
        return;
      }
      let opened = false;
      try {
        opened = await openSlackModal(interaction.trigger_id, answerView(action.value));
      } catch (err) {
        console.error("[slack] could not open the answer dialog:", (err as Error).message);
      }
      res.status(200).send("");
      if (!opened) {
        // A webhook-only Slack has no API to open a dialog with, so the
        // command that does the same job is offered instead of nothing.
        await replyToInteraction(
          responseUrl ?? "",
          `Typing an answer here needs a bot token. Either add one under Settings → Alerts, or answer with \`/dakyworld answer ${action.value} your answer\`.`,
        ).catch(() => undefined);
      }
      return;
    }

    // Acknowledged before the work, for the reason in the header comment.
    res.status(200).send("");

    if (!action?.action_id || !action.value) return;
    void handleAction(action.action_id, action.value, { userId, who, responseUrl }).catch((err) =>
      console.error("[slack] action failed:", (err as Error).message),
    );
  } catch (err) {
    next(err);
  }
});

async function notAllowed(responseUrl: string | null): Promise<void> {
  if (!responseUrl) return;
  await replyToInteraction(
    responseUrl,
    "You are not on the list of people who can decide these. Ask the Owner to add your Slack user id under Settings → Alerts.",
  ).catch(() => undefined);
}

/** The dialog an escalation's "Answer…" button opens. */
function answerView(taskId: string) {
  return {
    type: "modal",
    callback_id: ANSWER_VIEW.callbackId,
    // The task travels with the dialog rather than in a map on this server: a
    // deploy between opening the dialog and sending it must not lose it.
    private_metadata: taskId,
    title: { type: "plain_text", text: "Answer the agent" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: ANSWER_VIEW.blockId,
        label: { type: "plain_text", text: "What should it do?" },
        element: {
          type: "plain_text_input",
          action_id: ANSWER_VIEW.actionId,
          multiline: true,
          max_length: 2000,
          placeholder: { type: "plain_text", text: "Say what you want done. It carries on from where it stopped." },
        },
      },
    ],
  };
}

async function handleAction(
  actionId: string,
  value: string,
  ctx: { userId: string | null; who: string; responseUrl: string | null },
): Promise<void> {
  const say = async (text: string) => {
    if (ctx.responseUrl) await replyToInteraction(ctx.responseUrl, text);
  };

  // The signature proves the click came from Slack. It says nothing about
  // whether this person may decide — that is this check, and it now guards
  // spending and outward-facing actions as well as hires.
  if (!(await mayDecideFromSlack(ctx.userId))) {
    await say("You are not on the list of people who can decide these. Ask the Owner to add your Slack user id under Settings → Alerts.");
    return;
  }

  try {
    switch (actionId) {
      case APPROVAL_ACTIONS.approve: {
        const outcome = await approve(value, { slackUserId: ctx.userId, note: `Approved in Slack by ${ctx.who}.` });
        // Slack retries anything it does not hear from inside three seconds, so
        // a re-delivered click lands here having already been carried out. The
        // honest answer is what became of it, not a second attempt.
        if (outcome.alreadySettled) {
          await say(`That was already ${outcome.request.status.toLowerCase()} — nothing further has been done.`);
          return;
        }
        await settleApprovalCard(outcome.request, ctx.who);
        await say(
          outcome.request.status === "EXECUTED"
            ? "Done — carried out exactly as prepared."
            : `Approved, but it did not go through: ${outcome.request.error ?? "the tool refused it"}.`,
        );
        return;
      }
      case APPROVAL_ACTIONS.decline: {
        const outcome = await decline(value, { slackUserId: ctx.userId, note: `Declined in Slack by ${ctx.who}.` });
        if (outcome.alreadySettled) {
          await say(`That was already ${outcome.request.status.toLowerCase()}.`);
          return;
        }
        await settleApprovalCard(outcome.request, ctx.who);
        await say("Declined. Nothing was carried out, and the agent will be told when it next picks the task up.");
        return;
      }
      // --- A task that stopped and asked ------------------------------------
      case TASK_ACTIONS.option: {
        // `taskId::index`. Split from the right, because a cuid never contains
        // a colon but a future id shape might.
        const cut = value.lastIndexOf("::");
        const taskId = cut === -1 ? value : value.slice(0, cut);
        const index = cut === -1 ? 0 : Number.parseInt(value.slice(cut + 2), 10);
        const outcome = await answerWithOption(taskId, Number.isFinite(index) ? index : 0, { slackUserId: ctx.userId, who: `${ctx.who} in Slack` });
        await say(
          outcome.started
            ? "Answered — it has picked up where it stopped."
            : "Answered. That agent is on another job, so this goes back in the queue and starts as soon as it is free.",
        );
        return;
      }
      case TASK_ACTIONS.leave: {
        await leaveBlocked(value, { slackUserId: ctx.userId, who: `${ctx.who} in Slack` });
        await say("Left where it is. It stays on the Agents screen, and answering it later carries on from the same place.");
        return;
      }
      case TASK_ACTIONS.retry: {
        const outcome = await retryTask(value, { slackUserId: ctx.userId, who: `${ctx.who} in Slack` });
        await say(
          outcome.started
            ? "Running again, continuing from its checkpoint rather than starting over."
            : "Back in the queue. That agent is on another job, so it starts as soon as it is free.",
        );
        return;
      }
      case HIRE_ACTIONS.approve: {
        const result = await applyHire(value, { slackUserId: ctx.userId, note: `Approved in Slack by ${ctx.who}.` });
        await say(
          `Hired — \`${result.agentKey}\` is on the roster at autonomy 1 with dry run on.${
            result.resumedTaskId ? " The task that was waiting on this craft has gone back in the queue." : ""
          }`,
        );
        return;
      }
      case HIRE_ACTIONS.decline: {
        await declineHire(value, { slackUserId: ctx.userId, note: `Declined in Slack by ${ctx.who}.` });
        await say("Declined. The gap behind it stays open, so it can be answered a different way — closing the need itself is a separate decision.");
        return;
      }
      case HIRE_ACTIONS.undo: {
        const { retiredKey } = await withdrawHire(value, { slackUserId: ctx.userId, note: `Undone in Slack by ${ctx.who}.` });
        await say(`\`${retiredKey}\` is retired. It keeps its record — what it did is still readable — but it takes no more work.`);
        return;
      }
      case HIRE_ACTIONS.policyAuto: {
        await setHirePolicy("AUTO", `${ctx.who} in Slack`);
        await say(
          "Hiring is now *automatic*. The Agent Creator's proposals are created as soon as it makes them, still at autonomy 1 with dry run on — nothing a new agent decides takes effect until you raise it. Every hire still lands here with an Undo on it. Say `/dakyworld hiring ask` to go back.",
        );
        return;
      }
      case HIRE_ACTIONS.policyAsk: {
        await setHirePolicy("ASK", `${ctx.who} in Slack`);
        await say("Hiring is back to *ask first*. Nothing is created until you approve it here.");
        return;
      }
      default:
        return;
    }
  } catch (err) {
    if (err instanceof HireRefused || err instanceof ApprovalRefused || err instanceof AnswerRefused) {
      await say(err.message);
      return;
    }
    console.error("[slack] could not carry out that action:", (err as Error).message);
    await say("Something went wrong carrying that out. It has been logged, and nothing was changed.");
  }
}

// --- The slash command ------------------------------------------------------

/**
 * `/dakyworld hiring` and friends.
 *
 * The standing policy has to be changeable somewhere other than a hiring card,
 * or it can only be changed while one is on the screen. Answered inline —
 * these are a read and a setting write, both fast enough for Slack's three
 * seconds without the acknowledge-then-work dance the buttons need.
 */
slackRouter.post("/commands", async (req, res, next) => {
  try {
    const raw = await authenticate(req, res, "command");
    if (raw === null) return;

    const fields = formFields(raw);
    // Kept in the case it was typed. The topic is lowered for matching, and an
    // answer is a sentence a person wrote — lowercasing it would hand the agent
    // "yes, use the cedi price, not the usd one" and lose the names in it.
    const typed = (fields.text ?? "").trim();
    const text = typed.toLowerCase();
    const userId = fields.user_id ?? null;
    const who = fields.user_name ?? userId ?? "somebody in Slack";
    const [topic, argument] = text.split(/\s+/);

    const ephemeral = (message: string) => res.json({ response_type: "ephemeral", text: message });

    if (!topic || topic === "help") {
      return ephemeral(
        [
          "*What I answer:*",
          "`/dakyworld ping` — prove this workspace can reach Dakyworld OS",
          "`/dakyworld status` — what is waiting on you right now",
          "`/dakyworld tasks` — agents that stopped and asked something",
          "`/dakyworld answer <task id> <your answer>` — answer one of them, and it carries on",
          "`/dakyworld approvals` — actions prepared and waiting on a decision",
          "`/dakyworld hiring` — whether new agents are approved automatically or asked about first",
          "`/dakyworld hiring auto` — hire without asking me (still autonomy 1, dry run on)",
          "`/dakyworld hiring ask` — ask me first (the default)",
          "`/dakyworld hires` — what is waiting on a hiring decision",
          "`/dakyworld gaps` — crafts the agents say Dakyworld does not have",
        ].join("\n"),
      );
    }

    /**
     * The one command whose whole purpose is to prove the wiring.
     *
     * Reaching this line means the signature verified, which means the signing
     * secret is right, the request URL is right, the app is installed and this
     * server is the one Slack is talking to. Every one of those is otherwise
     * unobservable from inside Slack, and all five failures look identical
     * from a channel: a button that does nothing.
     *
     * It also leaves a mark. `verifySlackRequest` has already recorded that an
     * inbound request verified, so the Settings screen stops saying "no request
     * from Slack has ever arrived" the moment somebody runs this.
     */
    if (topic === "ping") {
      const health = await slackHealth();
      return ephemeral(
        [
          ":white_check_mark: *Slack can reach Dakyworld OS.* That proves the signing secret, the request URL and the app install all line up.",
          health.outbound.ready
            ? `Posting back out works too — ${health.outbound.transport === "TOKEN" ? `bot token, default channel ${health.outbound.channel}` : "incoming webhook"}.`
            : ":warning: Posting *out* is not set up, so cards will not appear here. Settings → Alerts.",
          health.inbound.openToAnyone
            ? ":warning: Nobody is named under “Who may approve”, so anyone who can see this channel can decide things."
            : `Deciding is limited to ${health.inbound.approvers.length} person(s).`,
        ].join("\n"),
      );
    }

    if (topic === "status") {
      const [waiting, approvals, prepared, hires, health] = await Promise.all([
        blockedTasks(5),
        countPending(),
        // Counted separately from the approval queue, and not folded into it.
        // A task finishes NEEDS_APPROVAL whenever *anything* was prepared, and
        // only the outward and spending calls become cards — so a run that
        // previewed a write to our own records is work waiting on a person with
        // nothing in the queue to represent it. Left out, this line would say
        // "nothing is waiting on you" about a task that is.
        prisma.agentTask.count({ where: { status: "NEEDS_APPROVAL", rehearsal: false } }),
        listHireRequests("PENDING"),
        slackHealth(),
      ]);
      const lines = [
        `*${waiting.length}* agent(s) stopped and asked · *${approvals}* action(s) waiting on a decision · *${prepared}* task(s) holding prepared work · *${hires.length}* hire(s) proposed`,
      ];
      if (waiting.length > 0) lines.push("", "*Stopped and asking:*", ...waiting.map((task) => `• ${task.agent.name} — ${task.blockedReason ?? task.title}`));
      if (health.problems.length > 0) lines.push("", `:warning: ${health.problems[0]}`);
      if (waiting.length === 0 && approvals === 0 && prepared === 0 && hires.length === 0) lines.push("", "Nothing is waiting on you.");
      return ephemeral(lines.join("\n"));
    }

    if (topic === "tasks") {
      const waiting = await blockedTasks(10);
      if (waiting.length === 0) return ephemeral("No agent is waiting on you. Nothing has stopped and asked.");
      return ephemeral(
        [
          "*Stopped and asking:*",
          ...waiting.map((task) =>
            [
              `• *${task.agent.name}* — ${task.blockedReason ?? task.title}`,
              task.options.length > 0 ? `   _Choices:_ ${task.options.join(" · ")}` : null,
              `   \`/dakyworld answer ${task.id} your answer\``,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        ].join("\n"),
      );
    }

    /**
     * `/dakyworld answer <task id> <words>`.
     *
     * The road that works on every setup. A dialog needs a bot token and a
     * button needs Interactivity; this needs neither, so a workspace connected
     * by one pasted webhook URL can still answer an agent — which is the whole
     * difference between an escalation and a task that quietly stopped.
     */
    if (topic === "answer") {
      if (!(await mayDecideFromSlack(userId))) {
        return ephemeral("You are not on the list of people who can answer these. Ask the Owner to add your Slack user id under Settings → Alerts.");
      }
      // Split off the topic and the id from the text as typed, so the answer
      // keeps its capitals and its punctuation.
      const rest = typed.replace(/^\S+\s*/, "");
      const [taskId, ...words] = rest.split(/\s+/);
      const answer = rest.slice(taskId ? taskId.length : 0).trim();
      if (!taskId || words.length === 0 || !answer) {
        return ephemeral("Say which task and what to do — `/dakyworld answer <task id> <your answer>`. `/dakyworld tasks` lists them with their ids.");
      }
      try {
        const outcome = await answerTask(taskId, answer, { slackUserId: userId, who: `${who} in Slack` });
        return ephemeral(
          outcome.started
            ? "Answered — it has picked up where it stopped."
            : "Answered. That agent is on another job, so this goes back in the queue and starts as soon as it is free.",
        );
      } catch (err) {
        if (err instanceof AnswerRefused) return ephemeral(err.message);
        throw err;
      }
    }

    if (topic === "approvals") {
      const pending = await listRequests("PENDING", 10);
      if (pending.length === 0) return ephemeral("Nothing is waiting on a decision.");
      return ephemeral(
        `*Prepared and waiting on you:*\n${pending
          .map((request) => `• *${request.agent.name}* — ${request.wouldDo.slice(0, 160)}${request.spends ? " :coin:" : ""}`)
          .join("\n")}`,
      );
    }

    if (topic === "hiring") {
      if (argument === "auto" || argument === "ask") {
        if (!(await mayDecideFromSlack(userId))) {
          return ephemeral("You are not on the list of people who can change this. Ask the Owner to add your Slack user id under Settings → Alerts.");
        }
        const policy = await setHirePolicy(argument.toUpperCase() as HirePolicy, `${who} in Slack`);
        return ephemeral(
          policy === "AUTO"
            ? "Hiring is now *automatic*. Proposals become agents as soon as the Agent Creator makes them — at autonomy 1 with dry run on, so nothing they decide takes effect. Each one still lands here with an Undo on it."
            : "Hiring is *ask first*. Nothing is created until you approve it here.",
        );
      }
      const current = await hirePolicy();
      const waiting = (await listHireRequests("PENDING")).length;
      return ephemeral(
        current === "AUTO"
          ? `Hiring is *automatic* — the Agent Creator's proposals become agents immediately, at autonomy 1 with dry run on. \`/dakyworld hiring ask\` to change it.`
          : `Hiring is *ask first*${waiting ? `, and ${waiting} proposal(s) are waiting on you` : ""}. \`/dakyworld hiring auto\` to change it.`,
      );
    }

    if (topic === "hires") {
      const pending = await listHireRequests("PENDING");
      if (pending.length === 0) return ephemeral("Nothing is waiting on a hiring decision.");
      return ephemeral(
        `*Waiting on you:*\n${pending
          .map((request) => `• *${request.name}* (\`${request.key}\`) — ${request.deliverable} · reports to \`${request.managerKey}\``)
          .join("\n")}`,
      );
    }

    if (topic === "gaps") {
      const gaps = await openGaps();
      if (gaps.length === 0) return ephemeral("No open skill gaps. Every craft an agent has asked for either exists or has been settled.");
      return ephemeral(
        `*Crafts nobody here has:*\n${gaps
          .map((gap) => `• *${gap.skillNeeded}* — asked for by ${gap.timesRequested} agent(s) [${gap.status.toLowerCase()}]`)
          .join("\n")}`,
      );
    }

    return ephemeral(`I do not know “${topic}”. Try \`/dakyworld help\`.`);
  } catch (err) {
    next(err);
  }
});
