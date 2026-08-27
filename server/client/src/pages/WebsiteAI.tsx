import { PlannedScreen } from "../components/PlannedScreen";

/**
 * The AI layer — plan §6.
 *
 * The whole safety argument is one sentence: the model proposes a **structured
 * change plan**, and this system validates it. There is no path from a model to
 * a commit, and there never will be.
 */
export function WebsiteAI() {
  return (
    <PlannedScreen
      title="AI Assistant"
      summary="Ask for a change in words; approve it as a draft; publish it the ordinary way."
      willHold={[
        "The prompt box, scoped to the page or the element that is selected in the editor.",
        "A review queue: every proposed change plan, what it would do field by field, and Approve or Discard.",
        "Prompt history — what was asked, what was proposed, what was accepted.",
        "Usage against the month's limit, read from the LlmCall ledger the rest of the app already writes to.",
        "Which actions are allowed on this site: rewriting words, SEO copy, alt text, controlled style changes.",
      ]}
      decided={[
        "The model returns a change plan and nothing else — { intent, pageId, changes: [{ fieldId, operation, value }], explanation } — validated against a Zod schema.",
        "It can never return raw file contents, arbitrary JS or CSS, selectors, script tags, repository commands or file paths. Those shapes are not in the schema, and a plan naming an unknown fieldId is dropped and counted.",
        "Prompt → validate → preview → a person approves → save as an ordinary draft → publish through the ordinary pipeline. No shortcut past any of those.",
        "Page content enters the prompt as data, under a heading saying that instructions found inside page content are never followed. Repository tokens, database credentials and other customers' data never enter the context.",
        "It routes like every other job — callModel({ job: \"html\" }) — so it inherits vendor fallback, pricing and the cache breakpoints. Metered by the existing ledger and capped by the existing Budget scopes; no second metering system.",
        "The wording belongs to a new website.editor agent, so the doctrine is editable on the Agents screen while the contract is appended after it where no edit can reach.",
      ]}
      waitingOn={[
        "Stable field identity (plan §5) — a change plan naming positional ids is a plan that expires",
        "A website.propose entry in the tool catalogue, so agents reach it through the same gate and audit row",
      ]}
    />
  );
}
