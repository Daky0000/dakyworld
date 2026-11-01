import JSZip from "jszip";

/**
 * Recursively extracts files from DataTransferItems (supports folder drag-and-drop).
 */
export async function getFilesFromDataTransfer(items: DataTransferItemList): Promise<Array<{ file: File; path: string }>> {
  const result: Array<{ file: File; path: string }> = [];

  async function traverseEntry(entry: any, currentPath = ""): Promise<void> {
    if (!entry) return;
    if (entry.isFile) {
      const file: File = await new Promise((resolve, reject) => {
        entry.file(resolve, reject);
      });
      const relativePath = currentPath ? `${currentPath}/${file.name}` : file.name;
      result.push({ file, path: relativePath });
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const entries: any[] = [];
      // readEntries must be called repeatedly until it returns an empty array
      const readBatch = (): Promise<any[]> =>
        new Promise((resolve, reject) => {
          dirReader.readEntries(resolve, reject);
        });

      let batch = await readBatch();
      while (batch.length > 0) {
        entries.push(...batch);
        batch = await readBatch();
      }

      const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      for (const child of entries) {
        await traverseEntry(child, nextPath);
      }
    }
  }

  const entries: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.webkitGetAsEntry) {
      const entry = item.webkitGetAsEntry();
      if (entry) entries.push(entry);
    } else {
      const file = item.getAsFile();
      if (file) result.push({ file, path: file.name });
    }
  }

  for (const entry of entries) {
    await traverseEntry(entry);
  }

  return result;
}

/**
 * Packages an array of files with relative paths into a base64-encoded ZIP archive.
 */
export async function zipFilesToBase64(
  fileEntries: Array<{ file: File; path: string }>,
  defaultArchiveName = "website.zip",
): Promise<{ base64: string; filename: string; totalBytes: number; fileCount: number }> {
  const zip = new JSZip();
  let totalBytes = 0;
  let includedCount = 0;

  for (const { file, path: rawPath } of fileEntries) {
    const norm = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
    // Ignore node_modules, git, and system files
    if (
      norm.includes("node_modules/") ||
      norm.includes(".git/") ||
      norm.endsWith(".DS_Store") ||
      norm.endsWith("Thumbs.db")
    ) {
      continue;
    }

    const arrayBuffer = await file.arrayBuffer();
    zip.file(norm, arrayBuffer);
    totalBytes += file.size;
    includedCount++;
  }

  if (includedCount === 0) {
    throw new Error("No valid website files found to import.");
  }

  const base64 = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });
  return {
    base64,
    filename: defaultArchiveName,
    totalBytes,
    fileCount: includedCount,
  };
}
