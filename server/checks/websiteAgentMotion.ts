/**
 * The Builder agent's animations are the Interactions tab's, property for
 * property. No database, no network.
 *
 * The agent writes `--dw-*` motion properties itself (`motionPatch`) rather
 * than through the tab, so the two could drift: a keyframe renamed in one, a
 * default changed in the other, and an element the agent animated would open
 * in the tab as "a keyframe this panel cannot describe". Here every trigger
 * and effect the agent offers is written both ways, from the same starting
 * style, and the patches must be identical.
 */
import assert from "node:assert/strict";
import { MOTION_EFFECTS, MOTION_TRIGGERS, describeMotion, motionPatch } from "../src/services/websiteAgentMotion.js";
import { defaultInteraction, effectsFor, readInteractions, writeInteraction, type Direction, type Effect, type Trigger } from "../client/src/lib/websiteMotion.js";

let compared = 0;
let refused = 0;
const starts: Array<Record<string, string>> = [{}, { "--dw-enter": "dw-enter-blur", "--dw-enter-dur": "900ms", transition: "transform 150ms, opacity 150ms" }];

for (const trigger of MOTION_TRIGGERS) {
  const offered = new Set(effectsFor(trigger as Trigger).flatMap((group) => group.effects));
  for (const effect of MOTION_EFFECTS) {
    for (const current of starts) {
      const mine = motionPatch(current, trigger, effect);
      if (effect === "none") {
        assert.ok("patch" in mine);
        assert.deepEqual(mine.patch, writeInteraction(current, trigger as Trigger, null), `${trigger} none`);
        compared += 1;
        continue;
      }
      const directed = /^(fade|slide)-from-(top|bottom|left|right)$/.exec(effect);
      const base = (directed?.[1] ?? effect) as Effect;
      const direction = (directed?.[2] ?? "") as Direction;
      if (!offered.has(base)) {
        assert.ok("refused" in mine, `${trigger} ${effect} is not offered by the tab, so the agent must not write it`);
        refused += 1;
        continue;
      }
      assert.ok("patch" in mine, `${trigger} ${effect} is offered by the tab`);
      const theirs = writeInteraction(current, trigger as Trigger, { ...defaultInteraction(trigger as Trigger), effect: base, direction });
      assert.deepEqual(mine.patch, theirs, `${trigger} ${effect} from ${JSON.stringify(current)}`);
      compared += 1;
    }
  }
}

// What the agent wrote, the tab reads back as the effect it is.
const applied = (patch: Record<string, string | null>) => Object.fromEntries(Object.entries(patch).filter((entry): entry is [string, string] => entry[1] !== null));
const rise = motionPatch({}, "view", "fade-from-bottom");
assert.ok("patch" in rise);
const [read] = readInteractions(applied(rise.patch));
assert.deepEqual([read?.trigger, read?.effect, read?.direction, read?.keyframe], ["view", "fade", "bottom", undefined], "the tab reads it as Fade from the bottom, scroll into view");
const onLoad = motionPatch({}, "load", "scale");
assert.ok("patch" in onLoad && onLoad.patch["--dw-enter-start"] === "load", "on page load is marked as such");
const spin = motionPatch({}, "loop", "slide-from-left");
assert.ok("refused" in spin && /cannot play continuously/.test(spin.refused), "a loop takes attention effects only");

assert.equal(describeMotion("view", "fade-from-bottom"), "Fades in from the bottom as it scrolls into view");
assert.equal(describeMotion("loop", "pulse"), "Pulses continuously");
assert.equal(describeMotion("hover", "none"), "No animation while the pointer is over it");

console.log(`websiteAgentMotion: ${compared} patches identical to the Interactions tab's, ${refused} combinations the tab does not offer refused — passed`);
