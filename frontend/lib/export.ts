/**
 * Client-side exporters for dataset views.
 *
 * CSV: hand-rolled, no dependencies. Tiny payload, fast.
 * XLSX: builds the small Open XML package directly and dynamically imports
 *       only the ZIP codec. This keeps export code out of the main bundle and
 *       avoids spreadsheet libraries with unpatched advisories.
 */

export interface ExportColumn {
  name: string;
}

export interface ExportRow {
  data: Record<string, unknown>;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  if (value == null) return "";
  let str = String(value);
  // Neutralize spreadsheet formula injection (=, +, -, @).
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  // RFC 4180: fields containing comma, quote, CR, or LF must be quoted;
  // quotes inside the field are doubled.
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCSV(
  columns: ExportColumn[],
  rows: ExportRow[],
): string {
  const header = columns.map((c) => csvEscape(c.name)).join(",");
  const body = rows
    .map((row) =>
      columns.map((c) => csvEscape(row.data[c.name])).join(","),
    )
    .join("\n");
  // BOM lets Excel open UTF-8 CSV with non-ASCII names correctly.
  return "﻿" + header + "\n" + body + "\n";
}

// ── Filename helpers ────────────────────────────────────────────────────────

function safeFilename(name: string, ext: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "dataset";
  return `${base}.${ext}`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Some browsers require the anchor to be in the DOM.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function downloadCSV(
  datasetName: string,
  columns: ExportColumn[],
  rows: ExportRow[],
): void {
  const csv = buildCSV(columns, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, safeFilename(datasetName, "csv"));
}

export async function downloadXLSX(
  datasetName: string,
  columns: ExportColumn[],
  rows: ExportRow[],
): Promise<void> {
  const { strToU8, zipSync } = await import("fflate");
  const sheetName =
    datasetName
      .replace(/[\\/?*[\]:]/g, "-")
      .replace(/^'+|'+$/g, "")
      .slice(0, 31) || "Dataset";
  const values: unknown[][] = [
    columns.map((column) => column.name),
    ...rows.map((row) => columns.map((column) => row.data[column.name])),
  ];
  const sheetRows = values
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = row
        .map((value, columnIndex) =>
          xlsxCell(value, `${columnLetters(columnIndex)}${rowNumber}`),
        )
        .join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows}</sheetData>
</worksheet>`),
  };

  const output = zipSync(files, { level: 6 });
  const bytes = new Uint8Array(output.byteLength);
  bytes.set(output);
  triggerDownload(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    safeFilename(datasetName, "xlsx"),
  );
}

function xlsxCell(value: unknown, reference: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}" t="n"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = spreadsheetText(value);
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

function spreadsheetText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return stripInvalidXml(value);
  try {
    return stripInvalidXml(JSON.stringify(value) ?? String(value));
  } catch {
    return stripInvalidXml(String(value));
  }
}

function stripInvalidXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnLetters(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}
