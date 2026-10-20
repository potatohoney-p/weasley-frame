"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import type { CellDetailView } from "@/lib/cell-evidence-view";

function IconX() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
    </svg>
  );
}
function IconCopy() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5"/>
    </svg>
  );
}
function IconExternalLink() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Shell                                                               */
/* ------------------------------------------------------------------ */

interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function SideSheet({ open, onClose, children }: SideSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Keyboard: Escape closes, Tab stays trapped inside.
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const panel = panelRef.current;

    const focusable = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
    );
    focusable[0]?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }

    panel.addEventListener("keydown", onKey);
    return () => panel.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-foreground/20 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Modal */}
      <div
        ref={panelRef}
        aria-labelledby="cell-detail-title"
        className="relative w-full max-w-lg max-h-[80vh] bg-surface border border-border rounded-xl shadow-2xl flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 id="cell-detail-title" className="text-sm font-semibold text-foreground">Cell Detail</h2>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center h-7 w-7 text-muted hover:text-foreground transition-colors rounded"
            aria-label="Close"
          >
            <IconX />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Content                                                             */
/* ------------------------------------------------------------------ */

type CellDetailProps = Omit<CellDetailView, "rowId">;

function isValidHttpUrl(src: string): boolean {
  try {
    const { protocol } = new URL(src);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function SourceLink({ url }: { url: string }) {
  return isValidHttpUrl(url) ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-start gap-1.5 text-xs text-link hover:underline break-all"
      data-ph-mask-text="true"
    >
      <span className="mt-0.5 shrink-0"><IconExternalLink /></span>
      {url}
    </a>
  ) : (
    <span className="text-xs text-muted break-all" data-ph-mask-text="true">{url}</span>
  );
}

function captureTime(timestamp: number): string | undefined {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function CellDetail({ column, value, evidence, rowLinks, latestRefresh }: CellDetailProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayValue = value == null || value === "" ? "—" : String(value);

  // Clear any pending timer when the component unmounts to avoid calling
  // setCopied on an already-gone component.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value == null ? "" : String(value));
      setCopied(true);
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. non-HTTPS dev); silently ignore.
    }
  }, [value]);

  return (
    <div className="space-y-6">
      {/* Column name + description */}
      <div>
        <p className="text-sm font-semibold text-foreground">{column.name}</p>
        {column.description && (
          <p className="text-xs text-muted mt-0.5">{column.description}</p>
        )}
      </div>

      {/* Value */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[11px] font-medium text-muted uppercase tracking-wide">
            Value <span className="normal-case">({column.type})</span>
          </p>
          <button
            type="button"
            onClick={() => { void handleCopy(); }}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted hover:text-foreground transition-colors"
            aria-label="Copy value"
          >
            {copied
              ? <><span className="text-green-500"><IconCheck /></span><span className="text-green-500">Copied</span></>
              : <><IconCopy /><span>Copy</span></>
            }
          </button>
        </div>
        <div
          className="rounded-lg border border-border bg-background px-4 py-3"
          data-ph-mask-text="true"
        >
          <p className="text-sm text-foreground break-all whitespace-pre-wrap">
            {displayValue}
          </p>
        </div>
      </div>

      <section aria-label="Captured evidence" className="space-y-3">
        <div>
          <h3 className="text-[11px] font-medium text-muted uppercase tracking-wide">
            Captured evidence
          </h3>
          <p className="text-xs text-muted mt-1">
            A capture records what was observed; it does not verify this value.
          </p>
        </div>
        {evidence.length === 0 ? (
          <p className="text-sm text-muted">No captured evidence</p>
        ) : (
          <ul className="space-y-3">
            {evidence.map((source, index) => (
              <li key={`${source.runId}:${source.captureId}:${index}`} className="rounded-lg border border-border p-3 space-y-2">
                <p className="text-xs font-medium text-foreground">
                  {source.kind === "search_snippet" ? "Search snippet" : "Page capture"}
                </p>
                <blockquote className="border-l-2 border-border pl-3 text-sm text-foreground whitespace-pre-wrap break-words" data-ph-mask-text="true">
                  {source.excerpt}
                </blockquote>
                <SourceLink url={source.url} />
                <p className="text-xs text-muted">
                  Captured <time dateTime={captureTime(source.capturedAt)}>{captureTime(source.capturedAt) ?? "at an unknown time"}</time>
                </p>
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer">Capture details</summary>
                  <dl className="mt-2 space-y-1 break-all" data-ph-mask-text="true">
                    <div><dt className="font-medium">SHA-256</dt><dd>{source.contentSha256}</dd></div>
                    <div><dt className="font-medium">Capture ID</dt><dd>{source.captureId}</dd></div>
                    <div><dt className="font-medium">Run ID</dt><dd>{source.runId}</dd></div>
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        )}
        <div className="rounded-lg bg-background p-3 text-xs text-muted">
          <p className="font-medium">Latest completed evidence refresh</p>
          {latestRefresh ? (
            <>
              <p className="mt-1">{latestRefresh.observed ? "Captured for this value" : "Not observed for this value"}</p>
              <time dateTime={captureTime(latestRefresh.completedAt)}>
                {captureTime(latestRefresh.completedAt) ?? "Completion time unavailable"}
              </time>
            </>
          ) : <p className="mt-1">No completed evidence refresh</p>}
        </div>
      </section>

      {rowLinks.length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-muted uppercase tracking-wide mb-1.5">
            Row links
          </p>
          <p className="text-xs text-muted mb-2">
            Links associated with the row, not evidence for this cell.
          </p>
          <ul className="space-y-1.5">
            {rowLinks.map((src, i) => (
              <li key={src || i}>
                <SourceLink url={src} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
