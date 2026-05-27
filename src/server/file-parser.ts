/**
 * file-parser.ts — PDF and DOCX → plain text extraction.
 *
 * Used by the /api/parse-file endpoint so users can attach documents
 * and have their content injected into the chat context.
 * No external services required — fully local, no GPU needed.
 */

import type { Buffer } from 'buffer';

export interface ParseResult {
  text: string;
  pageCount?: number;
  wordCount: number;
}

/**
 * Parse a PDF buffer → plain text.
 * Uses pdf-parse (pure JS, no native deps).
 */
export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(buffer);
  const text = data.text.trim();
  return {
    text,
    pageCount: data.numpages,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

/**
 * Parse a DOCX buffer → plain text (via mammoth → strips formatting).
 * mammoth preserves headings, paragraphs, and lists as readable text.
 */
export async function parseDocx(buffer: Buffer): Promise<ParseResult> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim();
  return {
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

/**
 * Dispatch to the right parser based on MIME type or filename extension.
 * Returns null if the file type is not supported.
 */
export async function parseDocument(
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<ParseResult | null> {
  const ext = filename.split('.').pop()?.toLowerCase();

  if (mimetype === 'application/pdf' || ext === 'pdf') {
    return parsePdf(buffer);
  }

  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimetype === 'application/msword' ||
    ext === 'docx' ||
    ext === 'doc'
  ) {
    return parseDocx(buffer);
  }

  return null;
}

/** Hard cap on extracted text to avoid blowing the context window. */
export const MAX_EXTRACTED_CHARS = 40_000;

export function truncateExtracted(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EXTRACTED_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_EXTRACTED_CHARS),
    truncated: true,
  };
}
