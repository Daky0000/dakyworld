import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Invoice } from "../lib/types";
import { Badge, Button, EmptyState, Money, PageHeader, Table } from "../components/ui";
import { EmailComposer, type ComposerTarget } from "../components/EmailComposer";

export function Invoices() {
  const qc = useQueryClient();
  const [emailing, setEmailing] = useState<ComposerTarget | null>(null);
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

  return (
    <div>
      <PageHeader title="Invoicing & Payments" subtitle="Generate invoices, track payments, manage receivables." />
      {isLoading ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : !invoices || invoices.length === 0 ? (
        <EmptyState message="No invoices yet." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-ink/10 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
              <th className="px-4 py-3">Invoice</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Due</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} className="border-b border-ink/5 last:border-0">
                <td className="px-4 py-3 font-medium">{inv.invoiceNumber}</td>
                <td className="px-4 py-3">{inv.client.name}</td>
                <td className="px-4 py-3">
                  <Money amount={inv.amountTotal} currency={inv.currency} />
                </td>
                <td className="px-4 py-3">{new Date(inv.dueDate).toLocaleDateString()}</td>
                <td className="px-4 py-3">
                  <Badge tone={inv.status === "PAID" ? "gold" : inv.status === "OVERDUE" ? "muted" : "default"}>{inv.status}</Badge>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => generatePdf.mutate(inv.id)}>
                      PDF
                    </Button>
                    {/* The invoice PDF is rendered when the email sends, not
                        now, so what lands is the invoice as it stands then. */}
                    <Button
                      variant="secondary"
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
                      <Button variant="secondary" onClick={() => send.mutate(inv.id)}>
                        Mark sent
                      </Button>
                    )}
                    {inv.status !== "PAID" && <Button onClick={() => markPaid.mutate(inv.id)}>Mark paid</Button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <EmailComposer target={emailing} open={emailing !== null} onClose={() => setEmailing(null)} />
    </div>
  );
}
