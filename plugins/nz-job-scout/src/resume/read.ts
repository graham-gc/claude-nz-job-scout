import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export interface ResumeDocument {
  path: string;
  format: 'markdown' | 'pdf';
  text: string;
}

export type PdfTextExtractor = (filePath: string) => Promise<string>;

export async function readResume(
  filePath: string,
  options: { extractPdfText?: PdfTextExtractor } = {},
): Promise<ResumeDocument> {
  const extension = extname(filePath).toLowerCase();

  if (extension === '.md' || extension === '.markdown') {
    return {
      path: filePath,
      format: 'markdown',
      text: await readFile(filePath, 'utf8'),
    };
  }

  if (extension === '.pdf') {
    if (!options.extractPdfText) {
      throw new Error(
        'PDF input requires a PDF text extractor. In the Claude Code skill workflow, use Claude document reading; CLI support will provide an adapter.',
      );
    }
    return {
      path: filePath,
      format: 'pdf',
      text: await options.extractPdfText(filePath),
    };
  }

  throw new Error(`Unsupported resume format: ${extension || '(no extension)'}. Use .pdf or .md.`);
}
