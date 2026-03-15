import "../polyfill";
import { PDFDocument } from "pdf-lib";
import * as zip from "@zip.js/zip.js";
import XlsxPopulate from "xlsx-populate";

const withRetry = async <T>(fn: () => Promise<T>, retries = 2, delay = 0): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    return withRetry(fn, retries - 1, delay);
  }
};

self.onmessage = async (e: MessageEvent) => {
  const { passwords, range, fileBuffer, fileName, workerId } = e.data;
  
  let currentPasswords: string[] = [];
  if (passwords) {
    currentPasswords = passwords;
  } else if (range) {
    const { start, end, pad } = range;
    for (let i = start; i < end; i++) {
      currentPasswords.push(i.toString().padStart(pad, '0'));
    }
  }

  const total = currentPasswords.length;
  let lastReportTime = Date.now();

  // Optimization: Pre-initialize ZIP reader once per worker chunk
  let zipReader: zip.ZipReader<any> | null = null;
  let firstFile: any = null;

  if (fileName.endsWith(".zip")) {
    try {
      zipReader = new zip.ZipReader<any>(new zip.Uint8ArrayReader(new Uint8Array(fileBuffer)));
      const entries = await zipReader.getEntries();
      const fileEntries = entries.filter(e => !e.directory);
      if (fileEntries.length > 0) {
        firstFile = fileEntries[0];
      } else {
        // Empty zip or only directories
        self.postMessage({ type: "success", password: "", workerId });
        return;
      }
    } catch (err) {
      // If we can't read the zip, it might be encrypted at the entry level or corrupted
    }
  }

  for (let i = 0; i < total; i++) {
    const pwd = currentPasswords[i];
    let success = false;

    try {
      if (fileName.endsWith(".pdf")) {
        try {
          // pdf-lib is the bottleneck for PDFs
          await PDFDocument.load(fileBuffer, { password: pwd } as any);
          success = true;
        } catch (err: any) {
          success = false;
        }
      } else if (fileName.endsWith(".zip")) {
        if (firstFile) {
          try {
            // zip.js optimization: reuse reader and only try to decrypt the first file
            await firstFile.getData(new zip.Uint8ArrayWriter(), { password: pwd });
            success = true;
          } catch (err: any) {
            success = false;
          }
        } else {
          success = false;
        }
      } else if (fileName.endsWith(".xlsx")) {
        try {
          // xlsx-populate is the bottleneck for Excel
          await XlsxPopulate.fromDataAsync(fileBuffer, { password: pwd });
          success = true;
        } catch (err: any) {
          success = false;
        }
      }
    } catch (err) {
      success = false;
    }

    if (success) {
      if (zipReader) await zipReader.close();
      self.postMessage({ type: "success", password: pwd, workerId });
      return;
    }

    // Report progress every 1000ms to minimize message overhead
    const now = Date.now();
    if (now - lastReportTime > 1000 || i === total - 1) {
      self.postMessage({ 
        type: "progress", 
        current: i + 1, 
        total, 
        password: pwd,
        workerId 
      });
      lastReportTime = now;
    }
  }

  if (zipReader) await zipReader.close();
  self.postMessage({ type: "done", workerId });
};
