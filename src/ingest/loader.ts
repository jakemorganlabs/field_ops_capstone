import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { PDFParse } from "pdf-parse";

export interface LoadedPage {
  page: number;
  text: string;
}

export interface LoadedDocument {
  filename: string;
  bytes: Buffer;
  content_hash: string;
  pages: LoadedPage[];
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadPdf(bytes: Buffer): Promise<LoadedPage[]> {
  const parser = new PDFParse({ data: bytes });
  const result = await parser.getText();
  await parser.destroy();
  return result.pages.map((page: { num: number; text: string }) => ({
    page: page.num,
    text: page.text || "",
  }));
}

async function loadMarkdown(bytes: Buffer): Promise<LoadedPage[]> {
  const text = bytes.toString("utf-8");
  return [
    {
      page: 1,
      text,
    },
  ];
}

export async function loadDocument(path: string): Promise<LoadedDocument> {
  const bytes = await readFile(path);
  const content_hash = hashBytes(bytes);
  const ext = extname(path).toLowerCase();
  const filename = path.split("/").pop() || path;

  let pages: LoadedPage[];
  if (ext === ".pdf") {
    pages = await loadPdf(bytes);
  } else if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
    pages = await loadMarkdown(bytes);
  } else {
    throw new Error(`unsupported file extension: ${ext}`);
  }

  return {
    filename,
    bytes,
    content_hash,
    pages,
  };
}
