# Model routing, fallbacks, structured output and what a turn costs

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

**Models are chosen by job, never by vendor** — `src/lib/models/`. A caller
says `callModel({ job: "text" })` and the routing decides who serves it:
**NVIDIA is the shipped default for every job except
images and cold outreach**, ChatGPT draws, and Perplexity researches companies,
checks facts against live sources, rewrites drafts into plain English, **makes
the redesign call on a homepage it has been shown** — the reason its adapter
takes a picture at all — and **writes the first message to a stranger**
(`job: "outreach"`).

**`outreach` is split out of `text` for two reasons and neither is style.** A
letter to a stranger and a project update to a client we have billed for a year
were the same job, so routing one moved the other — the shortest and most-read
thing this company produces could not be put on a different vendor from an
invoice covering note. And the thing that makes Perplexity right for it is the
live half: a cold message is judged on whether it sounds like somebody who went
and looked. **That is also the one way it could break `EVIDENCE_RULES`** — a
model that searches can return a fault about a business nobody in this system
checked, stated to the one person who knows whether it is true. So the search is
fenced: `ownDomain()` in `emailContext.ts` pins `search_domain_filter` to the
prospect's own hostname, one implementation imported by both drafters, and both
contracts carry the rule in words for the leads that have no domain to pin to —
a live search may **confirm** a handed fact and may never introduce one. The
cold and follow-up purposes route there; every other email stays on `text`. **A job whose chosen vendor has no key — or whose call fails
mid-flight — falls through a chain: the declared fallback first, then every
other vendor that can actually do that job**, so nothing waits on a credential
and each key the Owner pastes moves one job onto its chosen model.
`registry.ts` holds the vendors, the shipped routing, the published rates and
`standInsFor()`; `call.ts` holds one adapter per vendor.

Two things about the NVIDIA half: **the model id is verified against NVIDIA's
own catalogue at key-save time** (`verifyProviderKey` reads `GET /models`, free
and authenticated), so a slug that isn't listed fails on the screen with the
closest matches named rather than becoming a month of calls that quietly failed
over; and **one key reaches every model on the account**. NVIDIA's console
issues a key from an individual model's page, which makes it look as though each
model needs its own — it does not, and the free allowance is counted per
*account*, so a second key buys nothing but a second thing to keep secret.

**The vendor replaced OpenRouter on 1 Sep 2026, and the reason is the whole
feature.** OpenRouter served **one** free model to every job in the system, so
every job was only as good as that model was at the worst thing it was asked to
do — and when that one endpoint was busy or its daily cap was spent, everything
stopped together. NVIDIA lists a different model per kind of work, all of them
free on one OpenAI-shaped wire, so the ladder underneath each job is now three
models picked *for that job*.

**The free ladders: three free models per job, then the best paid one of
three** — `nvidia.freeModels`, `FREE_LADDER_BY_JOB` / `freeLadderFor()` and
`PAID_AGENT_CHAIN` in `registry.ts`. Every model NVIDIA serves on that endpoint
costs nothing per token. They are real models and they are also the least
reliable thing available: a free endpoint is shared, so it queues, rate-limits,
and some of the time simply does not answer. One of them as *the* model is a
system that stops working at busy times; three in a row with a paid floor behind
them is a system that costs nothing most days and never stops.

- **The assignment is the point.** `FREE_LADDER_BY_JOB` is eleven rows — every
  `ModelJob`, plus `agent` for the loop that runs the workforce. Three rules
  were applied to each: capability first (a model that cannot see is never in
  the `vision` ladder), three houses where three exist (free capacity goes
  short one provider at a time, and three models from one house is one rung
  wearing three hats), and nothing that is currently down. The spreadsheet job
  leads on the 1M-context model, triage and prompt-sorting lead on the smallest
  fastest one, `vision` holds only the three models that can actually look at a
  picture, and `agent` holds only verified tool-callers.
- **Capabilities are written down, not read from the catalogue, and that is not
  laziness.** NVIDIA's `/v1/models` returns `id`, `object`, `created` and
  `owned_by` — no pricing, no `supported_parameters`, nothing about tools,
  schemas or vision. OpenRouter published all of it, which is why the vendor
  this replaced could ask at runtime. Every flag in `FREE_MODELS` is the result
  of an actual request against the actual endpoint with the date recorded, and
  `checks/freeModels.ts` asserts the ladders against it. The catalogue
  contributes exactly one fact — *is this still listed* — which is what
  `pruneFreeLadders()` uses at boot to drop a rung the vendor has retired. It
  never *picks* a ladder, because a list picked from a capability-free
  catalogue would be three ids nobody has ever called.
- **On by default.** A deployment that never opens the Settings screen still
  starts every job on the models chosen for it. It shipped as an opt-in for one
  day in August 2026 and an opt-in nobody has opted into is a feature that does
  nothing.
- **Unset, empty and unreadable are three different states**, and conflating any
  two of them is a money bug. A job absent from the stored object uses its
  shipped ladder; a stored `[]` for that job is free models deliberately off and
  must survive a deploy; an unreadable row falls back to the shipped ladders
  rather than quietly starting to pay for things. **A bare array is unreadable
  now** — the setting holds an object keyed by job — which is worth knowing
  before writing one in a harness.
- **The paid floor is Claude, then ChatGPT, then Gemini** — the best of three,
  not one named vendor. A floor of one under a ladder built entirely out of
  endpoints that fail is a single point of failure in the place least able to
  afford one. The agent loop speaks all three wires — OpenAI chat completions
  for NVIDIA *and* ChatGPT, the SDK for Anthropic, `:generateContent` for
  Gemini — and translates each into the loop's Anthropic-shaped state.
- **Nothing starts from an empty page twice.** When an attempt fails having
  already written something — cut off at the token ceiling, or unreadable — that
  draft is handed to the next model as work to finish. The agent loop has always
  done this (the conversation, the tool results and the checkpoint survive a
  handover); `Carry` and `continuationBrief()` in `call.ts` are the same promise
  for the one-shot path, and `ModelResult.continuedFrom` names whose work was
  finished. Three deliberate calls: it rides in the **system prompt**, never as
  a prior assistant turn, because a message holding invalid JSON is one the next
  model is being asked to agree with and half of them will simply continue the
  broken string; a failure that produced **nothing** carries nothing, because an
  empty block headed "work already done" is worse than no block; and it applies
  to **every** vendor, not only the paid floor, because "do not start over"
  reads oddly if it only holds once money is involved.
- **The ladder replaces NVIDIA's model, it does not precede it.** Switched off,
  and **nothing about the model layer changes** — which is asserted, because a
  429 with free models off still requeues the task rather than moving the bill to
  a paid vendor, and that deliberate difference for one status is the thing most
  likely to get flattened into agreement by somebody reading one branch.
- **A rung gets one attempt and a short clock**, where the paid floor keeps the
  patient behaviour: `FREE_ATTEMPTS = 1`, 60s in `call.ts` and 120s for an agent
  turn, against four attempts and ninety seconds of backoff for a paid one.
  **What makes it a rung is that there is another one below it, not what it
  costs.** This was written as "is this model priced at zero" and gave the wrong
  answer: a rung picked from the unprobed half of the catalogue got the patient
  path, so a busy free endpoint held a person for ninety seconds before the
  *next free model* was asked.
- **A key-level refusal does not climb.** 401/402/403 are true of every model on
  the account, so climbing is three calls into the same wall and a slower
  failure. 400/404/429/5xx/silence are true of that model and say nothing about
  the next.
- **Both halves of the model layer had to be wired**, because they are two
  implementations of the same wire: `callModel` for one-shot work and
  `runAgentLoop` for an agent turn. A ladder in one and not the other works for
  writing an email and does nothing for the workforce.
- **A rung is priced at zero, explicitly.** Two ways to earn it: membership of
  `FREE_MODELS`, or membership of a ladder — including one the Owner picked from
  the part of NVIDIA's catalogue this app has never probed, which the picker
  offers and marks *unchecked*. Left unpriced a rung falls through to the floor
  rate, which is deliberately the dearest we know of: a free day would read as
  the most expensive one this company has ever had and trip every ceiling on
  money nobody spent.
- The picker shows what each model can actually do — sees images, tools, loose
  schema, not serving, unchecked — beside the model, because those are the
  reason to pick one row over another and the vendor publishes none of them.
  The Settings panel is **Free AI models**, with a job dropdown and a summary
  table of all eleven ladders underneath it: a dropdown that edits one row at a
  time needs that table, or the thing being configured is only ever visible one
  eleventh at a time.

`checks/freeModels.ts` (72) drives both paths against local fakes, including the
whole floor — three free rungs, a refused Claude, a broken ChatGPT, and Gemini
finishing the run over a third wire — plus the carry across a handover and the
negative that a rung which produced nothing carries nothing.
`tmp/nvidiaLive.ts` is the other half: one pass over the **real** endpoint,
proving every shipped rung answers, that the vision rungs can see a picture that
was actually sent, and that the agent loop can call a tool. It costs nothing and
needs `NVIDIA_API_KEY`.

**Two defects an earlier version of this uncovered, both invisible and both
live.** `model` in `runAgentLoop` was resolved once from whichever vendor came
first, so **every handover to Claude was asking Anthropic for a free model id** —
the failover that exists to save a run would have died on the model name. It
survived because the harness's fake Anthropic echoes a Claude id whatever it is
asked for, so "Claude finished the run" passed while the request said otherwise;
`checks/agentLoopNvidia.ts` now reads the model out of the **request body**.
And `BASE` in `call.ts` was captured at import while the agent loop had its own
per-call copy, so a harness repointing a vendor between scenarios got a frozen
address in one half and a live one in the other — a check that passes while
testing nothing, and on a machine with a real key one that spends money. There is
now **one** function, `vendorBase()` in `registry.ts`, imported by both halves:
two correct copies of the same fact are one copy away from two different facts,
and this pair has already been there once.

**Images route like everything else now, and used to be the one job that did
not** (1 Sep 2026). `generateImage` spoke OpenAI's `/images/generations` and
refused every other vendor outright, so the routing had to name ChatGPT and
only ChatGPT -- correct at the time, because a route that never serves is worse
than no route. The consequence was that the one job costing real money on every
single call was also the one with no free option and no fallback: no ChatGPT
key meant no pictures at all, and a rate-limited ChatGPT lost the ad concept
with nothing else to ask.

There are two wires now. `drawWithNvidia()` is free and first;
`drawWithOpenAI()` is the floor. Four things about NVIDIA's image wire, each of
which looks like a working request until you open the picture:

- **They are Cloud Functions, not an API.** `api.nvcf.nvidia.com/v2/nvcf/pexec/
  functions/<uuid>` -- the documented friendly path on `ai.api.nvidia.com`
  either hangs or answers "Not found for account", and the OpenAI-shaped
  catalogue does not list them at all. So `IMAGE_MODELS` is a **second
  catalogue**, deliberately not merged into `FREE_MODELS`: one dropdown holding
  both is how somebody picks FLUX for reading the post. `checks/freeModels.ts`
  asserts they do not overlap.
- **An unknown image model is refused rather than attempted.** On the text wire
  a slug is the address; here the address is a UUID nobody can guess.
- **`width`/`height` are honoured and `aspect_ratio` is accepted and ignored.**
  `aspect_ratio: "3:2"` returns 200 and a 1024x1024 image; `"16:9"` is a 422.
  The parameter that looks like it works is the one that does not, so the
  caller's `size` becomes width and height and `aspect_ratio` is never sent.
  Anything else -- `steps`, `cfg_scale`, `mode`, `n` -- is a 422 whose entire
  body is "Inference error", naming no field.
- **202 is queued, not failed**, and is polled on `nvcf-reqid`. Treating it as
  an error would read as "the free model failed" every time it was busy. And a
  declined prompt comes back **200** with a `finishReason` that is not
  `SUCCESS`, which is turned into a 422 here -- otherwise it reads as "produced
  nothing" and is handed to a paid vendor to be declined again.
- **The bytes are JPEG.** A `data:image/png` prefix on them is a broken image
  in every browser for a picture that arrived perfectly well.

One of the four models serves; the other three are ACTIVE on the account and
answer 504 or hang, so the shipped ladder is **one rung, not three** -- padding
it out with endpoints known not to serve is two wasted attempts and a minute of
somebody waiting before the paid vendor is asked. `tmp/nvidiaImage.ts` writes
what comes back to a file, because a base64 string of the right length is not
evidence that anything was drawn.

**The chain is not decoration — a two-step fallback had a hole in it.** `vision`
is routed to ChatGPT and fell back to Claude only, so a deployment holding a
Gemini key and nothing else had *no model at all* for looking at a page: the
audit paid Apify for two screenshots of a prospect's homepage and then filed
"the homepage was photographed but not reviewed", while a vendor that reads
pictures perfectly well sat connected and unasked. "No model is connected" is
now reserved for what it means — not one vendor that can do this job has a key —
and the sentence names all of them. A vendor that *cannot* do the job is never
in the chain, so Perplexity is never asked to look at a screenshot however many
keys are missing.

**The schema is sent in the shape the model will take, and said in words
whenever it will not be enforced.** Three states, not two, and finding that out
cost three probes — `FreeModel.schema` in `registry.ts`:

- `enforced` — takes `response_format: json_schema` and compiles it. The schema
  alone is the whole instruction.
- `accepted` — takes `json_schema`, answers 200, and returns an object with
  field names it invented. `google/diffusiongemma-26b-a4b-it` does this and
  **rejects `json_object` outright** ("requires a JSON schema"), so the schema
  still has to go on the wire; it just cannot be relied on.
- `object` — 500s on a strict schema and takes `json_object` instead.
  `meta/llama-3.2-90b-vision-instruct` is this one.

Anything but `enforced` gets `schemaContract()` written into its system prompt
as well, and so does a model this app has never probed. Without that the model
is asked for "a plan" with no description of one anywhere in the request,
because **not one caller in this app describes its answer in the prompt** —
every one describes it entirely in the schema, field names, enums, sentinels and
a `description` per field carrying the real instruction. The sheet analyst's
prompt says "return a plan" and never says what a plan looks like, because
`headerRow`, `firstDataRow`, the `-1` sentinel and the list of valid field
targets all live in the schema. `readJson()` also takes a second attempt at a
reply with a sentence of preamble around the object, which is what a model
*asked* for JSON rather than held to it routinely sends; it slices the
outermost braces and parses them, and never repairs malformed JSON, because
guessing what a truncated object meant is how a plan arrives with boundaries
nobody chose.

**The effort on the wire is low / medium / high and nothing else**, and this is
the one line in the model layer with a live 400 behind it: `openai/gpt-oss-120b`
and `-20b` answer `Input should be 'low', 'medium' or 'high'` to anything
outside that set. The mapping this replaced sent OpenRouter's own word `max` on
every high-effort call — carrying it across would have taken every high-effort
job down on two of the seven free models, and taken it down as a *request-shape*
failure, which climbs the ladder: the symptom would have been three free models
refusing all the important work and the paid floor quietly finishing it. A model
that does not declare `reasoning` at all is sent no effort — a parameter a model
ignores is free, one it rejects costs the whole request. `reasoningEffortFor()`
is a vendor fact and lives in `registry.ts`, read by both halves of the model
layer; it used to live inside the agent loop, so for as long as `callModel`
existed it put *nothing* on that wire and every routed job ran at the model's own
default. And **`max_tokens` caps reasoning plus reply on this wire**, exactly as
Anthropic's does, so a caller's budget sized for the answer was being spent
thinking: the sheet analyst asks for 16,000 because a plan describing forty
columns is genuinely long, and what came back was an empty message with
`finish_reason: "length"` — read correctly as "produced nothing usable" and
handed to the next vendor. The Owner paid for the reasoning, waited for it, and
got Claude's answer. `tokensWithReasoning()` budgets the thinking on top of the
answer, capped at 32,000. Same shape of bug as the missing prompt cache: nothing
breaks, every answer is correct, and the only symptom is the bill and a slower
import.

Four things that will bite:

- The four non-Anthropic vendors are spoken to over `fetch`, not SDKs. Anthropic
  keeps its SDK because the agent loop needs tool use and thinking blocks.
- **A chat-completions `content` is not reliably a string.** NVIDIA serves
  arbitrary open models and some answer with the parts array; that used to reach
  `.trim()` as an array and throw an *uncaught* `TypeError`, skipping every
  failover path below it and surfacing as "Something went wrong" about a
  spreadsheet the Owner was looking at. `assistantText()` normalises both
  shapes. A reasoning model's own thinking is deliberately not read even where
  the vendor returns it — it is not the answer.
- **Gemini rejects `additionalProperties` outright** rather than ignoring it,
  so `forGemini()` strips it on the way out. The schema the caller wrote is
  untouched — it is a translation, not an edit.
- **Perplexity bills per request as well as per token**, and the request fee is
  larger than the tokens on a short call. `REQUEST_FEES` is added to every
  priced Perplexity call; a cost worked out from tokens alone understates one
  by an order of magnitude.
- **Perplexity's `max_tokens` floor is 16.** Below it the answer is a 400, not a
  short reply, and a 400 during key verification reads to the Owner as a
  rejected key. `PERPLEXITY_MIN_TOKENS` clamps both the probe and every real
  call.
- **Perplexity is prepaid, so 401 does not mean "wrong key".** It answers 401
  for a perfectly valid key on an account with no credits left, and keys are
  only issued against a non-zero balance in the first place. Never flatten a
  401 into "rejected that API key" — `describeRejection()` carries the vendor's
  own sentence through, which is the only thing that separates *regenerate the
  key* from *top up the account*.

**The prompt cache is load-bearing and invisible, so it has a check.** An agent
turn re-sends everything before it — the system prompt, every tool definition,
the brief, and every tool result so far — and for a month this app paid full
input rate for all of it. `cache_control` appeared nowhere while `LlmCall` kept
a `cacheReadTokens` column that was always zero and `costOf` kept a multiplier
nothing multiplied. Nothing broke, no test failed, every answer was correct; the
only symptom was the bill, arriving a month later with no way to say which run
spent it.

- **Four breakpoints, and all four are used** (`lib/claudeAgent.ts`): the last
  tool definition, the system prompt, and a **rolling pair** on the two most
  recent user turns. Four is the API's hard limit and a fifth is a 400 — so an
  added one is not a slightly worse bill, it is every agent failing at once.
- **Two inside the conversation, never one.** The newest turn writes what just
  happened into the cache; the one behind it is what the *next* turn reads.
  Marking only the newest writes an entry every turn and reads none, which is
  the expensive half of caching with none of the saving.
- **Breakpoints are applied at send time and never stored.** `messages` is what
  the checkpoint holds, and a breakpoint frozen wherever a process happened to
  stop lands in the wrong place on resume.
- **The one-shot writers cache too**, gated on `CACHE_FLOOR_CHARS` — below
  Anthropic's 1,024-token floor nothing is cached at all, and a write costs a
  quarter more than sending it plainly, so marking a short prompt makes it
  dearer.
- `checks/promptCache.ts` drives the real loop against a fake Anthropic on
  localhost and asserts on **what went over the wire**, because a correct
  `withCacheBreakpoints()` that nothing calls is precisely the bug that was here.
- **None of it applies to the chat-completions wire, and that is a finding
  rather than a fix.** `chatCompletionsTurn()` sends no `cache_control` and
  reads no cache figures back — it takes `prompt_tokens` and
  `completion_tokens` and nothing else — so NVIDIA and ChatGPT turns record
  zero reads and zero writes however large the prompt. Deliberately left alone:
  the ladder puts every agent turn on a *free* rung first, where a full prompt
  costs nothing but latency, and the paid Claude floor goes through the SDK,
  which caches properly. Adding it would mean sending content-parts arrays
  through a wire that fronts arbitrary models, several of which do not accept
  the parameter, to save money on the one path that has none to save. Two
  consequences to know about: the cost screen's cache tile reads 0% for those
  turns and shows amber for a path where caching was never possible, and
  reducing the *constant weight* of a prompt — see the tool pruning under the
  agent runtime — is the only lever that helps there.

**An agent turn is priced by what the work is, not by what an agent is.**
`modelForEffort()` sends `low` and `medium` to `MODEL_ECONOMY` (Sonnet 5,
overridable at `anthropic.model.economy`) and everything above it to the
headline model. The split follows `effortFor()` in the runner: whoever writes to
somebody outside the company, and whoever sits on the board, keeps the expensive
model; a sub-agent reading a record or checking a link does not. Paying Opus
rates for the second was never a decision anybody made — it was `defaultModel()`
being the only answer the loop knew. **Named the cheap way round on purpose**: a
new effort level above `high` defaults to the better model rather than falling
through to the cheaper one because nobody listed it.

**A tool result is not paid for once.** It goes into the conversation and is
re-sent with every turn after it, so a 16,000-character blob on turn two is
still being billed on turn twelve. `TOOL_RESULT_MAX_CHARS` is 6,000 and
`clipToolResult()` **says when it has cut**, because a silent `.slice()` hands
the model half a record that reads as all of it — an agent concluding "there are
four communications on this lead" from a list cut at four has been misled by its
own tooling.

A tool that routes declares `requires: "models"` and a `job`, never a vendor —
naming one would make it refuse work the fallback could still do. What it must
do instead is **say who answered**: `content.factcheck` returns `checkedBy` and
`checkedAgainstLiveSources`, because checking a claim against a model's
training data is a much weaker thing than checking it against the live web and
whoever reads the result has to be able to tell which they got.

