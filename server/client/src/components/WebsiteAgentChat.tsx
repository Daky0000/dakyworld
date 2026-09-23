import { useState, useRef, useEffect } from "react";
import { api } from "../lib/api";
import { IconCheck, IconMessageSquare, IconUndo, IconUploadCloud } from "./WebsiteIcons";
import type {
  FieldEdit,
  SiteAgentPlan,
  SiteAgentApplyResult,
  SiteAgentAttachment,
  SiteAgentPermissionMode,
} from "../lib/types";

type ChatMessage = {
  id: string;
  sender: "user" | "agent";
  text: string;
  timestamp: string;
  userPrompt?: string;
  attachments?: SiteAgentAttachment[];
  plan?: SiteAgentPlan | null;
  applied?: boolean;
  autoApplied?: boolean;
  publishedLive?: boolean;
  publishingLive?: boolean;
  escalatedTicketId?: string | null;
  escalating?: boolean;
  requiresApproval?: boolean;
  applyResult?: SiteAgentApplyResult | null;
  error?: string | null;
};

const PERMISSION_MODE_STORAGE_KEY = "dw.websiteAgent.permissionMode";

const PERMISSION_MODES: Array<{
  id: SiteAgentPermissionMode;
  label: string;
  shortLabel: string;
  badgeClass: string;
  description: string;
}> = [
  {
    id: "full",
    label: "Full Auto-Edit (Edit Everything)",
    shortLabel: "Full Auto",
    badgeClass: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
    description:
      "Automatically executes all edits across the page or entire site. Only asks for approval before deleting elements or replacing entire text.",
  },
  {
    id: "smart",
    label: "Smart Auto-Edit (Default)",
    shortLabel: "Smart Auto",
    badgeClass: "bg-blue/20 text-blue border-blue/30",
    description:
      "Automatically applies routine edits, and asks for permission before deletions, replacing entire text, or whole-site changes across multiple pages.",
  },
  {
    id: "ask",
    label: "Ask First (Always Confirm)",
    shortLabel: "Ask First",
    badgeClass: "bg-amber-500/15 text-amber-700 border-amber-500/30",
    description:
      "Always shows a change proposal and waits for your explicit approval before modifying anything.",
  },
];

function SparkIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.944.976 1.684 1.92 1.92l1.036.258a.75.75 0 010 1.456l-1.036.258c-.944.236-1.684.976-1.92 1.92l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.92-1.92l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.92-1.92l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z"
      />
    </svg>
  );
}

function PermissionModeIcon({
  mode,
  className = "h-4 w-4",
}: {
  mode: SiteAgentPermissionMode;
  className?: string;
}) {
  if (mode === "full") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    );
  }
  if (mode === "ask") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
        />
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
      />
    </svg>
  );
}

function shouldPlanRequireApproval(plan: SiteAgentPlan, mode: SiteAgentPermissionMode): boolean {
  const hasActions =
    plan.summary.totalChanges > 0 ||
    (plan.structuralActions?.length ?? 0) > 0 ||
    Boolean(plan.editorCommand);
  if (!hasActions) return false;

  // Undo / Redo execute directly unless in strict "ask" mode
  if (plan.editorCommand === "undo" || plan.editorCommand === "redo") {
    return mode === "ask";
  }

  // Discard draft or deleting elements ALWAYS requires approval
  if (plan.editorCommand === "discard") return true;
  if (plan.structuralActions?.some((a) => a.kind === "remove")) return true;

  // High-risk actions (deletions, clearing text, or replacing entire text blocks) ALWAYS require approval
  if (plan.riskLevel === "high") return true;
  if (
    plan.approvalReasons?.some((r) =>
      /delet|remove|clear|entire text|discard/i.test(r),
    )
  ) {
    return true;
  }

  if (mode === "ask") return true;

  if (mode === "smart") {
    // Smart mode also asks permission for whole-site multi-page changes or backend-flagged approval items
    if (plan.requiresApproval) return true;
    if (plan.summary.affectedPages > 1) return true;
  }

  // In "full" mode, routine single-page and multi-page edits (colors, fonts, phone numbers, backgrounds, links, duplicate/move) execute automatically!
  return false;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function WebsiteAgentChat({
  pageId,
  pageTitle,
  siteId,
  siteName,
  selectedFieldId,
  fieldLabel,
  edits,
  canEdit,
  canUndo = false,
  canRedo = false,
  onApplyLocalEdits,
  onUndo,
  onRedo,
  onStructureAction,
  onDiscardDraft,
  onReloadPreview,
}: {
  pageId: string;
  pageTitle: string;
  siteId: string;
  siteName: string;
  selectedFieldId: string | null;
  fieldLabel?: string | null;
  edits: Record<string, FieldEdit>;
  canEdit: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onApplyLocalEdits: (values: Record<string, FieldEdit>) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onStructureAction?: (
    kind: "remove" | "duplicate" | "before" | "after",
    fieldId: string,
    targetId?: string,
  ) => void;
  onDiscardDraft?: () => void;
  onReloadPreview?: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<SiteAgentAttachment[]>([]);
  const [showPermissionMenu, setShowPermissionMenu] = useState(false);

  const [permissionMode, setPermissionMode] = useState<SiteAgentPermissionMode>(() => {
    try {
      const saved = localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
      if (saved === "full" || saved === "smart" || saved === "ask") return saved;
    } catch {
      // ignore storage errors
    }
    return "smart";
  });

  function selectPermissionMode(next: SiteAgentPermissionMode) {
    setPermissionMode(next);
    setShowPermissionMenu(false);
    try {
      localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }

  const initialWelcomeMessage: ChatMessage = {
    id: "welcome",
    sender: "agent",
    text: `Hi! I'm your Website Builder Agent for ${siteName}. I can do almost anything on your website:\n\n• Edit any text, heading, button, link, or styling\n• Change fonts, colors, phone numbers & emails across all pages\n• Upload images or files to replace backgrounds, swap photos, or link buttons to downloads\n• Duplicate, reorder, or delete sections & undo/redo changes\n\nTap the shield/bolt icon above anytime to choose whether I should auto-edit everything or ask permission first!`,
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };

  const chatStorageKey = `dw.websiteAgent.chat.${siteId}`;
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const cached = sessionStorage.getItem(chatStorageKey);
      if (cached) {
        const parsed = JSON.parse(cached) as ChatMessage[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore storage errors
    }
    return [initialWelcomeMessage];
  });
  const [excludedFieldsByMsg, setExcludedFieldsByMsg] = useState<Record<string, string[]>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(chatStorageKey, JSON.stringify(messages.slice(-30)));
    } catch {
      // ignore storage quota errors
    }
  }, [messages, chatStorageKey]);

  function toggleFieldSelection(messageId: string, pageIdKey: string, fieldIdKey: string) {
    const composite = `${pageIdKey}:${fieldIdKey}`;
    setExcludedFieldsByMsg((prev) => {
      const current = prev[messageId] ?? [];
      const exists = current.includes(composite);
      return {
        ...prev,
        [messageId]: exists ? current.filter((k) => k !== composite) : [...current, composite],
      };
    });
  }

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isOpen]);

  // Focus input when chat opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  async function handleFilesSelected(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length || !canEdit) return;

    setIsUploading(true);
    try {
      const uploaded: SiteAgentAttachment[] = [];
      for (const file of list) {
        const dataUrl = await fileToDataUrl(file);
        const rawBase64 = dataUrl.replace(/^data:[^;]+;base64,/i, "");
        const asset = await api.post<SiteAgentAttachment>(
          `/website/sites/${siteId}/agent/upload`,
          {
            filename: file.name,
            data: rawBase64,
            dataUrl,
            alt: file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " "),
          },
        );
        uploaded.push(asset);
      }
      setPendingAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: `err-upload-${Date.now()}`,
        sender: "agent",
        text:
          err instanceof Error
            ? `Attachment upload failed: ${err.message}`
            : "Failed to upload attachment.",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        error: "Attachment upload error",
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function publishBatchForMessage(messageId: string, plan: SiteAgentPlan) {
    if (!canEdit) return;
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, publishingLive: true, error: null } : m)),
    );
    try {
      const pageIds = plan.pages.map((p) => p.pageId);
      await api.post(`/website/sites/${siteId}/agent/publish-batch`, {
        pageIds,
        message: `Website Agent: ${plan.explanation.slice(0, 120)}`,
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, publishingLive: false, publishedLive: true }
            : m,
        ),
      );
      onReloadPreview?.();
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                publishingLive: false,
                error: err instanceof Error ? err.message : "Failed to publish changes live.",
              }
            : m,
        ),
      );
    }
  }

  async function escalateToDeveloper(messageId: string, promptText: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, escalating: true } : m)),
    );
    try {
      const res = await api.post<{ ticketId: string; message: string }>(
        `/website/sites/${siteId}/agent/escalate`,
        {
          prompt: promptText || "Developer assistance requested from Website Builder Agent",
          pageId,
          reason: "Requested from Website Agent Chat",
        },
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, escalating: false, escalatedTicketId: res.ticketId }
            : m,
        ),
      );
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                escalating: false,
                error: err instanceof Error ? err.message : "Could not send developer request.",
              }
            : m,
        ),
      );
    }
  }

  async function executePlan(messageId: string, plan: SiteAgentPlan, isAuto = false) {
    if (!canEdit) return;

    try {
      // 1. Handle editor commands (undo / redo / discard)
      if (plan.editorCommand === "undo") {
        onUndo?.();
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId
              ? {
                  ...msg,
                  applied: true,
                  autoApplied: isAuto,
                  requiresApproval: false,
                }
              : msg,
          ),
        );
        return;
      }

      if (plan.editorCommand === "redo") {
        onRedo?.();
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId
              ? {
                  ...msg,
                  applied: true,
                  autoApplied: isAuto,
                  requiresApproval: false,
                }
              : msg,
          ),
        );
        return;
      }

      if (plan.editorCommand === "discard") {
        onDiscardDraft?.();
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId
              ? {
                  ...msg,
                  applied: true,
                  autoApplied: isAuto,
                  requiresApproval: false,
                }
              : msg,
          ),
        );
        return;
      }

      // 2. Handle structural actions (remove / duplicate / move before or after)
      if (plan.structuralActions && plan.structuralActions.length > 0) {
        for (const action of plan.structuralActions) {
          if (action.pageId === pageId && onStructureAction) {
            onStructureAction(action.kind, action.fieldId, action.targetId);
          } else {
            await api.post(`/website/pages/${action.pageId}/structure`, {
              kind: action.kind,
              fieldId: action.fieldId,
              targetId: action.targetId,
            });
          }
        }
      }

      // 3. Apply field/style/link/background changes (filtering out any unchecked fields)
      const excludedSet = new Set(excludedFieldsByMsg[messageId] ?? []);
      const filteredPages = plan.pages
        .map((p) => {
          if (excludedSet.size === 0) return p;
          const keptChanges = p.changes.filter((c) => !excludedSet.has(`${p.pageId}:${c.fieldId}`));
          const keptFieldIds = new Set(keptChanges.map((c) => c.fieldId));
          const keptEdits = Object.fromEntries(
            Object.entries(p.edits).filter(([fid]) => keptFieldIds.has(fid)),
          );
          return {
            ...p,
            changes: keptChanges,
            edits: keptEdits,
          };
        })
        .filter((p) => p.changes.length > 0);

      let result: SiteAgentApplyResult | null = null;
      if (filteredPages.length > 0) {
        const currentPagePlan = filteredPages.find((p) => p.pageId === pageId);
        if (currentPagePlan) {
          onApplyLocalEdits(currentPagePlan.edits);
        }

        const pageRevisions = Object.fromEntries(
          filteredPages.map((p) => [p.pageId, p.draftRevision]),
        );
        result = await api.post<SiteAgentApplyResult>(
          `/website/sites/${siteId}/agent/apply`,
          {
            pageRevisions,
            plan: {
              explanation: plan.explanation,
              pages: filteredPages,
            },
          },
        );

        // If any edit references an uploaded site asset (/assets/dw/...), reload preview so embedded assets render immediately
        const usesUploadedAsset = filteredPages.some((p) =>
          p.changes.some((c) => c.after.includes("/assets/dw/")),
        );
        if (usesUploadedAsset) {
          onReloadPreview?.();
        }
      }

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                applied: true,
                autoApplied: isAuto,
                requiresApproval: false,
                applyResult:
                  result ?? {
                    appliedPages: filteredPages.length || 1,
                    totalChanges:
                      filteredPages.reduce((acc, p) => acc + p.changes.length, 0) ||
                      (plan.structuralActions?.length ?? 1),
                    results: [],
                  },
              }
            : msg,
        ),
      );
    } catch (err) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                error: err instanceof Error ? err.message : "Failed to apply changes.",
              }
            : msg,
        ),
      );
    }
  }

  async function sendMessage(textToSend?: string) {
    const rawText = (textToSend ?? input).trim();
    const attachmentsToSend = [...pendingAttachments];

    // Allow sending if user typed a prompt OR attached a file
    const text =
      rawText ||
      (attachmentsToSend.length > 0
        ? attachmentsToSend[0].kind === "image"
          ? "Replace my background with this image"
          : "Let this button link to this file"
        : "");

    if (!text || isPending) return;

    const userMsgId = `user-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      sender: "user",
      text,
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    const recentHistory = messages
      .filter((m) => m.id !== "welcome")
      .slice(-8)
      .map((m) => ({
        role: (m.sender === "user" ? "user" : "assistant") as "user" | "assistant",
        text: m.text.slice(0, 600),
        targetFieldIds: m.plan?.pages
          .flatMap((p) => p.changes.map((c) => c.fieldId))
          .slice(0, 10),
      }));

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setPendingAttachments([]);
    setIsPending(true);

    try {
      const plan = await api.post<SiteAgentPlan>(`/website/sites/${siteId}/agent/plan`, {
        action: "instruction",
        prompt: text,
        pageId,
        selectedFieldId,
        edits,
        attachments: attachmentsToSend,
        history: recentHistory,
      });

      const hasActionableChanges =
        plan.summary.totalChanges > 0 ||
        (plan.structuralActions?.length ?? 0) > 0 ||
        Boolean(plan.editorCommand);

      const needsApproval = shouldPlanRequireApproval(plan, permissionMode);
      const agentMsgId = `agent-${Date.now()}`;

      const agentMsg: ChatMessage = {
        id: agentMsgId,
        sender: "agent",
        text: plan.explanation || "I've analyzed your website and prepared the requested update.",
        userPrompt: text,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        plan: hasActionableChanges ? plan : null,
        requiresApproval: needsApproval,
      };

      setMessages((prev) => [...prev, agentMsg]);

      // Auto-apply immediately when approval is not required!
      if (hasActionableChanges && !needsApproval && canEdit) {
        await executePlan(agentMsgId, plan, true);
      }
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        sender: "agent",
        text:
          err instanceof Error
            ? err.message
            : "I couldn't process that request. Please try again.",
        userPrompt: text,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        error: "Failed to generate plan",
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsPending(false);
    }
  }

  const currentModeInfo =
    PERMISSION_MODES.find((m) => m.id === permissionMode) ?? PERMISSION_MODES[1];

  const defaultQuickPrompts = [
    "Change every font family to Inter",
    "Change color #08101F to #1E293B",
    "Update phone number across all pages",
    "Duplicate selected section",
  ];

  const attachmentQuickPrompts =
    pendingAttachments.length > 0
      ? pendingAttachments.some((a) => a.kind === "image")
        ? [
            "Replace my background with this image",
            "Set hero background to this image",
            "Replace selected image with this photo",
            "Let this button link to this file",
          ]
        : [
            "Let this button link to this file",
            "Link main CTA button to download this file",
            "Update selected link to this file",
          ]
      : defaultQuickPrompts;

  return (
    <>
      {/* -------------------------------------------------------------
          1. Floating Action Icon (Stacked with rounded shapes around it)
          ------------------------------------------------------------- */}
      <div className="fixed bottom-6 right-6 z-[9999] print:hidden select-none">
        <div className="relative flex items-center justify-center group">
          {/* Outermost stacked rounded shape (soft blue halo ring) */}
          <div
            className={`absolute -inset-2.5 rounded-3xl bg-blue/20 ring-1 ring-blue/30 transition-all duration-300 pointer-events-none ${
              isOpen
                ? "scale-105 opacity-100"
                : "group-hover:scale-110 group-hover:opacity-100 opacity-70"
            }`}
          />

          {/* Middle stacked rounded shape (offset card layer) */}
          <div
            className={`absolute -inset-1 rounded-2xl border-2 border-line bg-white shadow-md transition-all duration-300 pointer-events-none ${
              isOpen
                ? "rotate-6 scale-100"
                : "-rotate-3 group-hover:-rotate-6 group-hover:scale-105"
            }`}
          />

          {/* Floating hover hint badge */}
          {!isOpen && (
            <div className="pointer-events-none absolute right-full mr-3 hidden sm:flex items-center gap-1.5 rounded-full border border-line bg-white/95 px-3 py-1 text-xs font-medium text-ink shadow-lift backdrop-blur-xs transition-all duration-200 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 whitespace-nowrap">
              <SparkIcon className="h-3.5 w-3.5 text-blue fill-blue" />
              <span>Builder Agent</span>
              <span className="rounded-full bg-cream px-1.5 py-0.2 text-[10px] text-muted">
                {currentModeInfo.shortLabel}
              </span>
            </div>
          )}

          {/* Innermost primary button (Accessible high-contrast palette) */}
          <button
            type="button"
            aria-label={
              isOpen ? "Close Website Builder Agent" : "Open Website Builder Agent Chat"
            }
            aria-expanded={isOpen}
            onClick={() => setIsOpen((prev) => !prev)}
            className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-[#08101F] text-white shadow-2xl transition-all duration-200 hover:scale-105 active:scale-95 focus:outline-none focus:ring-4 focus:ring-blue/40"
          >
            {isOpen ? (
              <svg
                className="h-6 w-6 stroke-current"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="2.2"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <div className="relative flex items-center justify-center">
                <SparkIcon className="h-7 w-7 text-white fill-white" />
                <span className="absolute -top-1.5 -right-1.5 flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500 border-2 border-[#08101F]"></span>
                </span>
              </div>
            )}
          </button>
        </div>
      </div>

      {/* -------------------------------------------------------------
          2. Chat Window Interface (With Autonomy Icon, Undo/Redo, & Attachments)
          ------------------------------------------------------------- */}
      {isOpen && (
        <div
          role="dialog"
          aria-label="Website Builder Agent Chat"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer.files?.length) {
              void handleFilesSelected(e.dataTransfer.files);
            }
          }}
          className="fixed bottom-24 right-6 z-[9999] flex h-[620px] max-h-[calc(100vh-7.5rem)] w-[calc(100vw-2.5rem)] max-w-[440px] flex-col overflow-hidden rounded-3xl border border-line bg-white shadow-2xl transition-all animate-in fade-in slide-in-from-bottom-4 duration-200"
        >
          {/* Header */}
          <div className="relative flex flex-none items-center justify-between border-b border-line bg-cream px-3.5 py-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink text-white shadow-xs">
                <SparkIcon className="h-5 w-5 text-white fill-white" />
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-positive-text ring-2 ring-white" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h3 className="truncate font-display text-sm font-semibold text-ink leading-tight">
                    Builder Agent
                  </h3>
                </div>
                <p className="truncate text-[11px] text-muted">
                  <strong className="text-ink font-medium">{pageTitle}</strong>
                  {fieldLabel ? ` · ${fieldLabel}` : ""}
                </p>
              </div>
            </div>

            {/* Header Controls: Permission/Autonomy Icon, Undo, Redo, Reset, Close */}
            <div className="flex items-center gap-1 shrink-0">
              {/* Permission / Autonomy Mode Selector Button */}
              <button
                type="button"
                onClick={() => setShowPermissionMenu((v) => !v)}
                title={`Autonomy Mode: ${currentModeInfo.label}. Tap to configure when the agent asks for permission.`}
                className={`flex items-center gap-1 rounded-xl border px-2 py-1 text-[11px] font-semibold transition ${
                  permissionMode === "full"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 hover:bg-emerald-500/20"
                    : permissionMode === "ask"
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-800 hover:bg-amber-500/20"
                      : "border-blue/30 bg-blue/10 text-blue hover:bg-blue/20"
                }`}
              >
                <PermissionModeIcon mode={permissionMode} className="h-3.5 w-3.5" />
                <span>{currentModeInfo.shortLabel}</span>
              </button>

              {/* Quick Undo */}
              {onUndo && (
                <button
                  type="button"
                  title="Undo last change on page"
                  disabled={!canUndo}
                  onClick={onUndo}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink transition disabled:opacity-35"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                </button>
              )}

              {/* Quick Redo */}
              {onRedo && (
                <button
                  type="button"
                  title="Redo change on page"
                  disabled={!canRedo}
                  onClick={onRedo}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink transition disabled:opacity-35"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6" />
                  </svg>
                </button>
              )}

              {/* Reset Conversation */}
              <button
                type="button"
                title="Reset conversation"
                onClick={() => setMessages([initialWelcomeMessage])}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink transition"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              </button>

              {/* Close */}
              <button
                type="button"
                title="Close chat"
                onClick={() => setIsOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink transition"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Permission / Autonomy Mode Popover Drawer */}
            {showPermissionMenu && (
              <div className="absolute left-3 right-3 top-full mt-1.5 z-50 rounded-2xl border border-line bg-white p-3 shadow-2xl">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink">
                    Agent Edit & Permission Mode
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowPermissionMenu(false)}
                    className="rounded-lg px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-sunken hover:text-ink transition"
                  >
                    Done
                  </button>
                </div>
                <div className="space-y-1.5">
                  {PERMISSION_MODES.map((m) => {
                    const active = m.id === permissionMode;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => selectPermissionMode(m.id)}
                        className={`flex w-full items-start gap-2.5 rounded-xl border p-2.5 text-left transition ${
                          active
                            ? "border-2 border-blue bg-sunken shadow-xs"
                            : "border-line bg-white hover:border-blue hover:bg-sunken"
                        }`}
                      >
                        <div
                          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                            active ? "bg-blue text-white" : "bg-sunken text-ink border border-line"
                          }`}
                        >
                          <PermissionModeIcon mode={m.id} className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-ink">{m.label}</span>
                            {active && (
                              <span className="shrink-0 rounded-full bg-blue px-2 py-0.5 text-[10px] font-semibold text-white">
                                Active
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[11px] leading-snug text-muted">
                            {m.description}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/15 px-2.5 py-1.5 text-[10px] text-amber-800">
                  <strong>Safety Guard:</strong> Deleting sections or replacing entire text blocks will always ask for your confirmation first.
                </div>
              </div>
            )}
          </div>

          {/* Messages Area */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3.5 bg-white">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.sender === "user" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed ${
                    msg.sender === "user"
                      ? "bg-ink text-white rounded-br-xs shadow-xs"
                      : "bg-cream text-ink border border-line/80 rounded-bl-xs shadow-xs"
                  }`}
                >
                  {/* User Message Attachments Preview */}
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {msg.attachments.map((att) =>
                        att.kind === "image" ? (
                          <div
                            key={att.id}
                            className="flex items-center gap-1.5 rounded-lg bg-white/15 p-1 pr-2 text-[11px]"
                          >
                            <img
                              src={att.previewUrl || att.url}
                              alt={att.filename}
                              className="h-8 w-8 rounded object-cover bg-white"
                            />
                            <span className="max-w-[130px] truncate">{att.filename}</span>
                          </div>
                        ) : (
                          <div
                            key={att.id}
                            className="flex items-center gap-1.5 rounded-lg bg-white/15 px-2 py-1 text-[11px]"
                          >
                            <span className="rounded bg-white/20 px-1 py-0.5 font-mono text-[9px] uppercase">
                              {att.filename.split(".").pop() || "FILE"}
                            </span>
                            <span className="max-w-[140px] truncate">{att.filename}</span>
                          </div>
                        ),
                      )}
                    </div>
                  )}

                  <p className="whitespace-pre-wrap">{msg.text}</p>

                  {/* Plan Proposal / Auto-Execution Card */}
                  {msg.plan && (
                    <div className="mt-3 overflow-hidden rounded-xl border border-line bg-white p-3 text-ink shadow-xs">
                      <div className="flex items-center justify-between border-b border-line pb-2 mb-2 gap-2">
                        <span className="font-semibold text-xs text-blue">
                          {msg.plan.structuralActions?.length
                            ? `Structure Action (${msg.plan.structuralActions.length})`
                            : msg.plan.editorCommand
                              ? `Editor Command: ${msg.plan.editorCommand.toUpperCase()}`
                              : `Changes: ${msg.plan.summary.totalChanges} across ${msg.plan.summary.affectedPages} page${
                                  msg.plan.summary.affectedPages === 1 ? "" : "s"
                                }`}
                        </span>
                        {msg.requiresApproval && !msg.applied && (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-800 border border-amber-500/30">
                            Approval Required
                          </span>
                        )}
                      </div>

                      {/* Approval Reason Alert Banner */}
                      {msg.requiresApproval &&
                        !msg.applied &&
                        msg.plan.approvalReasons &&
                        msg.plan.approvalReasons.length > 0 && (
                          <div className="mb-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-950">
                            <div className="font-semibold flex items-center gap-1">
                              <span>⚠️ Permission Requested:</span>
                            </div>
                            <ul className="mt-1 list-disc pl-4 space-y-0.5 text-[10px]">
                              {msg.plan.approvalReasons.map((reason, idx) => (
                                <li key={idx}>{reason}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                      {/* Structural Actions Summary */}
                      {msg.plan.structuralActions && msg.plan.structuralActions.length > 0 && (
                        <div className="mb-2 space-y-1">
                          {msg.plan.structuralActions.map((sa, idx) => (
                            <div
                              key={idx}
                              className="flex items-center justify-between rounded-lg bg-sunken px-2.5 py-1.5 text-[11px]"
                            >
                              <span className="font-medium text-ink">
                                {sa.kind === "remove"
                                  ? "🗑️ Delete section/element"
                                  : sa.kind === "duplicate"
                                    ? "📋 Duplicate section/element"
                                    : `↕️ Move ${sa.kind}`}
                              </span>
                              <span className="text-[10px] text-muted truncate max-w-[140px]">
                                {sa.label}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Summary of affected pages with per-field selection checkboxes */}
                      {msg.plan.pages.length > 0 && (
                        <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                          {msg.plan.pages.map((p) => (
                            <div key={p.pageId} className="rounded-lg bg-sunken p-2 text-[11px]">
                              <div className="font-semibold text-ink">{p.pageTitle}</div>
                              <div className="mt-1 space-y-1">
                                {p.changes.slice(0, 6).map((c, i) => {
                                  const isChecked = !(excludedFieldsByMsg[msg.id] ?? []).includes(
                                    `${p.pageId}:${c.fieldId}`,
                                  );
                                  return (
                                    <label
                                      key={i}
                                      className="flex items-center justify-between text-muted text-[10px] gap-2 cursor-pointer select-none"
                                    >
                                      <span className="flex items-center gap-1.5 min-w-0 truncate">
                                        {!msg.applied && (
                                          <input
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={() =>
                                              toggleFieldSelection(msg.id, p.pageId, c.fieldId)
                                            }
                                            className="h-3 w-3 rounded border-line text-blue focus:ring-blue/30"
                                          />
                                        )}
                                        <span className="truncate">
                                          {c.label} ({c.property})
                                        </span>
                                      </span>
                                      <span className="truncate max-w-[140px] font-mono text-ink">
                                        {c.after || "(cleared)"}
                                      </span>
                                    </label>
                                  );
                                })}
                                {p.changes.length > 6 && (
                                  <span className="text-[10px] text-muted">
                                    +{p.changes.length - 6} more
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Action / Approval Footer */}
                      {!msg.applied ? (
                        <div className="mt-3 flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => msg.plan && executePlan(msg.id, msg.plan, false)}
                            className={`rounded-xl px-3 py-1.5 text-xs font-semibold text-white transition active:scale-95 ${
                              msg.plan.riskLevel === "high"
                                ? "bg-danger-text hover:opacity-90"
                                : "bg-ink hover:bg-ink/90"
                            }`}
                          >
                            {msg.requiresApproval
                              ? "Approve & Apply Changes"
                              : "Apply to drafts"}
                          </button>
                        </div>
                      ) : (
                        <div className="mt-2.5 space-y-2">
                          <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-positive-text">
                            <span className="inline-flex items-center gap-1.5">
                              <IconCheck />
                              <span>{msg.autoApplied ? "Auto-applied" : "Approved & applied"} to drafts</span>
                            </span>
                            <div className="flex items-center gap-1.5">
                              {onUndo && (
                                <button
                                  type="button"
                                  onClick={onUndo}
                                  className="inline-flex items-center gap-1 rounded-lg border border-line bg-cream px-2 py-0.5 text-[10px] font-semibold text-ink hover:bg-sunken transition"
                                >
                                  <IconUndo size={12} />
                                  <span>Undo</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {msg.plan.pages.length > 0 && (
                            <div className="flex items-center justify-between rounded-lg border border-line bg-sunken px-2.5 py-1.5">
                              {msg.publishedLive ? (
                                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-positive-text">
                                  <IconUploadCloud size={13} />
                                  <span>Published live to {siteName}</span>
                                </span>
                              ) : (
                                <>
                                  <span className="text-[10px] text-muted">
                                    Ready to push live ({msg.plan.pages.length} page
                                    {msg.plan.pages.length === 1 ? "" : "s"})
                                  </span>
                                  <button
                                    type="button"
                                    disabled={msg.publishingLive}
                                    onClick={() =>
                                      msg.plan && void publishBatchForMessage(msg.id, msg.plan)
                                    }
                                    className="rounded-lg bg-blue px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-blue-light transition disabled:opacity-50"
                                  >
                                    {msg.publishingLive
                                      ? "Publishing…"
                                      : `Publish All (${msg.plan.pages.length})`}
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {msg.error && (
                        <p className="mt-2 text-[11px] text-danger-text">{msg.error}</p>
                      )}
                    </div>
                  )}

                  {/* Developer Handoff Escalation Card when a request requires custom code or couldn't be auto-planned */}
                  {msg.sender === "agent" &&
                    msg.id !== "welcome" &&
                    (!msg.plan || Boolean(msg.error)) && (
                      <div className="mt-2.5 rounded-xl border border-line bg-white p-2.5 text-ink shadow-2xs">
                        {msg.escalatedTicketId ? (
                          <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-positive-text">
                            <IconCheck />
                            <span>Sent to your Dakyworld Developer team (Ticket #{msg.escalatedTicketId.slice(0, 8)}). We have full context of this page.</span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] text-muted">
                              Need a custom layout or code change?
                            </span>
                            <button
                              type="button"
                              disabled={msg.escalating}
                              onClick={() =>
                                void escalateToDeveloper(
                                  msg.id,
                                  msg.userPrompt || msg.text,
                                )
                              }
                              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-sunken px-2.5 py-1 text-[10px] font-semibold text-ink hover:border-blue hover:text-blue transition disabled:opacity-50"
                            >
                              <IconMessageSquare size={12} />
                              <span>{msg.escalating ? "Sending…" : "Hand off to Developer"}</span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                </div>
                <span className="mt-1 px-1 text-[10px] text-muted">{msg.timestamp}</span>
              </div>
            ))}

            {isPending && (
              <div className="flex items-start">
                <div className="rounded-2xl rounded-bl-xs border border-line bg-cream px-3.5 py-2.5 text-xs text-muted shadow-xs">
                  <span className="flex items-center gap-1.5">
                    <SparkIcon className="h-3.5 w-3.5 text-blue fill-blue animate-pulse" />
                    Working on your website…
                  </span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Pending Attachments Strip (when user attaches an image or document) */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-none items-center gap-2 overflow-x-auto border-t border-line bg-sunken px-3 py-2">
              {pendingAttachments.map((att) => (
                <div
                  key={att.id}
                  className="flex shrink-0 items-center gap-2 rounded-xl border border-line bg-white p-1.5 pr-2 shadow-2xs"
                >
                  {att.kind === "image" ? (
                    <img
                      src={att.previewUrl || att.url}
                      alt={att.filename}
                      className="h-8 w-8 rounded-lg object-cover border border-line"
                    />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue/15 text-[10px] font-bold uppercase text-blue">
                      {att.filename.split(".").pop() || "DOC"}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="max-w-[120px] truncate text-[11px] font-medium text-ink">
                      {att.filename}
                    </div>
                    <div className="text-[9px] text-muted">
                      {att.kind === "image" ? "Image ready" : "File ready to link"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removePendingAttachment(att.id)}
                    title="Remove attachment"
                    className="ml-1 flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-ink transition"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Quick Prompts Bar */}
          <div className="flex flex-none items-center gap-1.5 overflow-x-auto border-t border-line bg-sunken px-3 py-2">
            <span className="text-[10px] font-semibold text-muted shrink-0">
              {pendingAttachments.length > 0 ? "With file:" : "Try:"}
            </span>
            {attachmentQuickPrompts.map((promptText) => (
              <button
                key={promptText}
                type="button"
                onClick={() => void sendMessage(promptText)}
                disabled={isPending || isUploading}
                className="shrink-0 rounded-full border border-line bg-white px-2.5 py-0.5 text-[11px] text-muted hover:border-blue hover:bg-sunken hover:text-ink transition disabled:opacity-50"
              >
                {promptText}
              </button>
            ))}
          </div>

          {/* Chat Input Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage();
            }}
            className="flex flex-none items-end gap-2 border-t border-line bg-white p-3"
          >
            {/* Hidden file input for images & documents */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip,.mp4,.mp3"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void handleFilesSelected(e.target.files);
                }
              }}
              className="hidden"
            />

            {/* Active Attachment Upload Button */}
            <button
              type="button"
              disabled={isPending || isUploading || !canEdit}
              onClick={() => fileInputRef.current?.click()}
              title="Attach image or file (replace backgrounds, swap images, or link buttons to files)"
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition ${
                pendingAttachments.length > 0
                  ? "border-blue bg-blue/15 text-blue"
                  : "border-line bg-sunken text-ink hover:border-blue hover:bg-sunken hover:text-blue"
              } disabled:opacity-40`}
            >
              {isUploading ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue border-t-transparent" />
              ) : (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                  />
                </svg>
              )}
            </button>

            {/* Input textarea */}
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                if (e.clipboardData?.files?.length) {
                  e.preventDefault();
                  void handleFilesSelected(e.clipboardData.files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              disabled={isPending}
              placeholder={
                pendingAttachments.length > 0
                  ? "Tell me what to do with this attachment (e.g., replace my background)…"
                  : "Ask to edit text, styles, backgrounds, links, undo/redo…"
              }
              className="min-h-[38px] max-h-24 flex-1 resize-none rounded-xl border border-line bg-sunken p-2 text-xs text-ink placeholder:text-muted outline-none hover:border-blue focus:border-blue focus:ring-2 focus:ring-blue/25 transition"
            />

            {/* Send button */}
            <button
              type="submit"
              disabled={isPending || isUploading || (!input.trim() && pendingAttachments.length === 0)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue text-white transition hover:bg-blue-light active:scale-95 disabled:opacity-40"
              title="Send message (Enter)"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2.2"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </button>
          </form>
        </div>
      )}
    </>
  );
}
