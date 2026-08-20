import { Router, type Request, type Response } from "express";
import {
  mayDecideFromSlack,
  replyToInteraction,
  verifySlackRequest,
} from "../lib/slack.js";
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
async function authenticate(req: Request, res: Response): Promise<string | null> {
  const raw = rawBodyOf(req);
  const check = await verifySlackRequest(req.headers as Record<string, unknown>, raw);
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
  actions?: BlockAction[];
}

slackRouter.post("/actions", async (req, res, next) => {
  try {
    const raw = await authenticate(req, res);
    if (raw === null) return;

    const payload = formFields(raw).payload;
    if (!payload) return res.status(400).send("No payload.");

    let interaction: Interaction;
    try {
      interaction = JSON.parse(payload) as Interaction;
    } catch {
      return res.status(400).send("That payload was not JSON.");
    }

    if (interaction.type !== "block_actions") return res.status(200).send("");

    const action = interaction.actions?.[0];
    const responseUrl = interaction.response_url ?? null;
    const userId = interaction.user?.id ?? null;
    const who = interaction.user?.name ?? userId ?? "somebody in Slack";

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

async function handleAction(
  actionId: string,
  value: string,
  ctx: { userId: string | null; who: string; responseUrl: string | null },
): Promise<void> {
  const say = async (text: string) => {
    if (ctx.responseUrl) await replyToInteraction(ctx.responseUrl, text);
  };

  if (!(await mayDecideFromSlack(ctx.userId))) {
    await say("You are not on the list of people who can decide hires. Ask the Owner to add your Slack user id under Settings → Alerts.");
    return;
  }

  try {
    switch (actionId) {
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
    if (err instanceof HireRefused) {
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
    const raw = await authenticate(req, res);
    if (raw === null) return;

    const fields = formFields(raw);
    const text = (fields.text ?? "").trim().toLowerCase();
    const userId = fields.user_id ?? null;
    const who = fields.user_name ?? userId ?? "somebody in Slack";
    const [topic, argument] = text.split(/\s+/);

    const ephemeral = (message: string) => res.json({ response_type: "ephemeral", text: message });

    if (!topic || topic === "help") {
      return ephemeral(
        [
          "*What I answer:*",
          "`/dakyworld hiring` — whether new agents are approved automatically or asked about first",
          "`/dakyworld hiring auto` — hire without asking me (still autonomy 1, dry run on)",
          "`/dakyworld hiring ask` — ask me first (the default)",
          "`/dakyworld hires` — what is waiting on a decision",
          "`/dakyworld gaps` — crafts the agents say Dakyworld does not have",
        ].join("\n"),
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
