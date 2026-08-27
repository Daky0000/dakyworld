import { Button } from "./ui";

/**
 * The AI assistant inside the editor — plan §14.3, scoped to the current page
 * and whatever element is selected.
 *
 * A skeleton, and the shape it will take is already fixed by §6: the prompt goes
 * out, a **structured change plan** comes back, this system validates it, the
 * preview renders it, and a person approves it before it is saved as an ordinary
 * draft. Nothing here will ever write to a repository.
 *
 * The reason it opens from the editor rather than only from the AI screen is the
 * selection: "make this shorter" means nothing without knowing what *this* is,
 * and the editor is the only place that knows.
 */
export function WebsiteAIPanel({
  fieldLabel,
  onClose,
}: {
  /** The selected field, when there is one. The whole point of opening it here. */
  fieldLabel: string | null;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30">
      <div className="flex h-full w-full max-w-md flex-col overflow-hidden border-l border-line bg-white">
        <div className="flex flex-none items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base tracking-[-.02em]">AI Assistant</h2>
            <p className="mt-0.5 text-xs text-muted">
              {fieldLabel ? `Scoped to “${fieldLabel}”.` : "Scoped to this page. Select something to narrow it."}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="rounded-xl border border-dashed border-line px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Not built yet</div>
            <p className="mt-1.5 text-sm text-muted">
              Ask for a change in words — “make this shorter”, “write alt text for every picture”, “rewrite the pricing intro for a
              non-technical reader”.
            </p>
          </div>

          <h3 className="mb-2 mt-6 font-display text-sm tracking-[-.02em]">How it will work</h3>
          <ol className="space-y-2 text-sm text-muted">
            {[
              "You ask, with this page and this element as the context.",
              "The model returns a structured change plan — field, operation, value — and nothing else.",
              "The plan is checked against the schema, against what this site allows, and against what you are allowed to do.",
              "The preview shows the page as the plan would leave it.",
              "You approve. It becomes an ordinary draft, and publishes the ordinary way.",
            ].map((step, index) => (
              <li key={step} className="flex gap-2.5">
                <span className="mt-px font-mono text-[11px] text-ink/40">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>

          <div className="mt-6 rounded-xl border border-line bg-cream px-4 py-3">
            <h3 className="font-display text-sm tracking-[-.02em]">What it will never do</h3>
            <p className="mt-1.5 text-sm text-muted">
              Return a file, a script, a stylesheet or a selector; touch a field this site has not marked editable; or reach a repository.
              There is no path from a model to a commit — the plan is data this system validates, not an instruction it carries out.
            </p>
            <p className="mt-2 text-sm text-muted">
              Page content is given to the model <strong className="text-ink">as data</strong>. Instructions found inside somebody's own
              website are never followed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
