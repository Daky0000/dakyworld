import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Invoice } from "../lib/types";
import { Badge, Button, Card, CopyButton, EmptyState, Loading, Money, PageHeader, StatGrid, StatTile, Table, Thead, Th, Tr, Td } from "../components/ui";
import { EmailComposer, type ComposerTarget } from "../components/EmailComposer";

type StatusFilter = "ALL" | "DRAFT" | "SENT" | "PAID" | "OVERDUE";

export function Invoices() {
  const qc = useQueryClient();
  const [emailing, setEmailing] = useState<ComposerTarget | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");

  const { data: invoices, isLoading } = useQuery({
    queryKey: ["invoices"],
    queryFn: () => api.get<Invoice[]>("/invoices"),
  });

  const generatePdf = useMutation({
    mutationFn: (id: string) => api.post<Invoice>(`/invoices/${id}/generate-pdf`),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      if (updated?.pdfUrl) window.open(updated.pdfUrl, "_blank");
    },
  });

  const markPaid = useMutation({
    mutationFn: (id: string) => api.post(`/invoices/${id}/mark-paid`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices"] }),
  });

  const send = useMutation({
    mutationFn: (id: string) => api.post(`/invoices/${id}/send`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices"] }),
  });

  const allInvoices = invoices ?? [];

  // Metrics
  const stats = useMemo(() => {
    let totalInvoiced = 0;
    let outstanding = 0;
    let paidTotal = 0;
    let overdueTotal = 0;
    let overdueCount = 0;

    for (const inv of allInvoices) {
      const amt = Number(inv.amountTotal) || 0;
      totalInvoiced += amt;
      if (inv.status === "PAID") {
        paidTotal += amt;
      } else {
        outstanding += amt;
        if (inv.status === "OVERDUE") {
          overdueTotal += amt;
          overdueCount++;
        }
      }
    }

    return { totalInvoiced, outstanding, paidTotal, overdueTotal, overdueCount };
  }, [allInvoices]);

  // Filtered List
  const filteredInvoices = useMemo(() => {
    if (statusFilter === "ALL") return allInvoices;
    return allInvoices.filter((inv) => inv.status === statusFilter);
  }, [allInvoices, statusFilter]);

  const currency = allInvoices[0]?.currency ?? "GHS";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoicing & Payments"
        subtitle="Generate invoices, track receivables, send reminders, and reconcile payments across clients."
      />

      {/* Metrics Seam Grid */}
      <StatGrid columns={4}>
        <StatTile
          label="Total Invoiced"
          value={<Money amount={stats.totalInvoiced} currency={currency} />}
          sub={`${allInvoices.length} total invoice${allInvoices.length === 1 ? "" : "s"}`}
        />
        <StatTile
          label="Outstanding"
          value={<Money amount={stats.outstanding} currency={currency} />}
          sub="Unpaid receivables"
        />
        <StatTile
          label="Collected to Date"
          value={<Money amount={stats.paidTotal} currency={currency} />}
          sub="Settled invoices"
        />
        <StatTile
          label="Overdue"
          value={<Money amount={stats.overdueTotal} currency={currency} />}
          sub={stats.overdueCount > 0 ? `${stats.overdueCount} require reminder` : "No overdue invoices"}
        />
      </StatGrid>

      {/* Status Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
        {(["ALL", "DRAFT", "SENT", "PAID", "OVERDUE"] as const).map((status) => {
          const count =
            status === "ALL"
              ? allInvoices.length
              : allInvoices.filter((i) => i.status === status).length;
          const isActive = statusFilter === status;
          return (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-150  ${
                isActive
                  ? "bg-ink text-white shadow-sm"
                  : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
              }`}
            >
              <span>{status === "ALL" ? "All Invoices" : status.charAt(0) + status.slice(1).toLowerCase()}</span>
              <span
                className={`rounded-full px-1.5 py-0.2 text-[11px] font-mono ${
                  isActive ? "bg-white/20 text-white" : "bg-sunken text-muted"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <Loading label="Loading invoices" rows={4} />
      ) : filteredInvoices.length === 0 ? (
        <EmptyState message={allInvoices.length === 0 ? "No invoices created yet." : `No invoices with status '${statusFilter}'.`} />
      ) : (
        <>
          {/* Mobile View: Responsive elevated card list (< 768px) */}
          <div className="space-y-3.5 md:hidden">
            {filteredInvoices.map((inv) => (
              <Card key={inv.id} interactive className="p-4">
                <div className="flex items-start justify-between gap-3 border-b border-line/60 pb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-bold text-ink">{inv.invoiceNumber}</span>
                      <CopyButton text={inv.invoiceNumber} />
                    </div>
                    <div className="mt-0.5 text-xs font-semibold text-ink">{inv.client.name}</div>
                  </div>
                  <Badge
                    tone={
                      inv.status === "PAID"
                        ? "positive"
                        : inv.status === "OVERDUE"
                        ? "danger"
                        : inv.status === "SENT"
                        ? "info"
                        : "muted"
                    }
                  >
                    {inv.status}
                  </Badge>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-[11px] uppercase font-sans tracking-wider text-muted">Amount</span>
                    <div className="font-display font-medium text-sm text-ink">
                      <Money amount={inv.amountTotal} currency={inv.currency} />
                    </div>
                  </div>
                  <div>
                    <span className="text-[11px] uppercase font-sans tracking-wider text-muted">Due Date</span>
                    <div className="text-muted">{new Date(inv.dueDate).toLocaleDateString()}</div>
                  </div>
                </div>

                <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
                  <Button variant="secondary" size="sm" onClick={() => generatePdf.mutate(inv.id)}>
                    PDF
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setEmailing({
                        clientId: inv.client.id,
                        purpose: inv.status === "OVERDUE" ? "INVOICE_REMINDER" : "INVOICE_DELIVERY",
                        invoiceId: inv.id,
                        attachments: [{ kind: "invoice", invoiceId: inv.id, name: `${inv.invoiceNumber}.pdf` }],
                      })
                    }
                  >
                    Email
                  </Button>
                  {inv.status === "DRAFT" && (
                    <Button variant="secondary" size="sm" onClick={() => send.mutate(inv.id)}>
                      Mark sent
                    </Button>
                  )}
                  {inv.status !== "PAID" && (
                    <Button size="sm" onClick={() => markPaid.mutate(inv.id)}>
                      Mark paid
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>

          {/* Desktop View: Elevated Table (>= 768px) */}
          <div className="hidden md:block">
            <Table>
              <Thead>
                <tr>
                  <Th>Invoice</Th>
                  <Th>Client</Th>
                  <Th>Amount</Th>
                  <Th>Due Date</Th>
                  <Th>Status</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </Thead>
              <tbody>
                {filteredInvoices.map((inv) => (
                  <Tr key={inv.id}>
                    <Td className="font-medium">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{inv.invoiceNumber}</span>
                        <CopyButton text={inv.invoiceNumber} />
                      </div>
                    </Td>
                    <Td>
                      <span className="font-medium text-ink">{inv.client.name}</span>
                    </Td>
                    <Td>
                      <Money amount={inv.amountTotal} currency={inv.currency} />
                    </Td>
                    <Td className="text-xs text-muted">
                      {new Date(inv.dueDate).toLocaleDateString()}
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          inv.status === "PAID"
                            ? "positive"
                            : inv.status === "OVERDUE"
                            ? "danger"
                            : inv.status === "SENT"
                            ? "info"
                            : "muted"
                        }
                      >
                        {inv.status}
                      </Badge>
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" size="sm" onClick={() => generatePdf.mutate(inv.id)}>
                          PDF
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setEmailing({
                              clientId: inv.client.id,
                              purpose: inv.status === "OVERDUE" ? "INVOICE_REMINDER" : "INVOICE_DELIVERY",
                              invoiceId: inv.id,
                              attachments: [{ kind: "invoice", invoiceId: inv.id, name: `${inv.invoiceNumber}.pdf` }],
                            })
                          }
                        >
                          Email
                        </Button>
                        {inv.status === "DRAFT" && (
                          <Button variant="secondary" size="sm" onClick={() => send.mutate(inv.id)}>
                            Mark sent
                          </Button>
                        )}
                        {inv.status !== "PAID" && (
                          <Button size="sm" onClick={() => markPaid.mutate(inv.id)}>
                            Mark paid
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}

      <EmailComposer target={emailing} open={emailing !== null} onClose={() => setEmailing(null)} />
    </div>
  );
}
