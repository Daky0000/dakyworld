import { prisma } from "../../lib/prisma.js";

/**
 * The rollout switch for automatic redesign concepts.
 *
 * Off by default, and off deliberately: a redesign concept is the half of this
 * feature that can be wrong about a business rather than merely absent, and
 * every gate in front of it — the eligibility rule, the quality checks, the
 * review, the approval, the send claim — was written before anybody had
 * watched them work on a real lead. So they get watched first, on ten leads
 * built by hand, and the automatic path is switched on afterwards.
 *
 * The switch governs the **automatic** path only. A person pressing Build, or
 * an agent tool called with `force`, is a decision somebody took; this is
 * about the leads nobody looked at.
 *
 * Stored rather than an environment variable so it can be turned off in the
 * middle of a bad night without a redeploy — which is the only moment anybody
 * will actually want it.
 */
export const AUTO_REDESIGN_KEY = "concept.autoRedesign";

export async function autoRedesignEnabled(): Promise<boolean> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: AUTO_REDESIGN_KEY } });
    return row?.value === "true";
  } catch {
    // A switch that cannot be read is a switch that is off. The failure mode
    // on the other side is a page built for a stranger because the database
    // blinked.
    return false;
  }
}

export async function setAutoRedesign(enabled: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: AUTO_REDESIGN_KEY },
    create: { key: AUTO_REDESIGN_KEY, value: enabled ? "true" : "false" },
    update: { value: enabled ? "true" : "false" },
  });
}
