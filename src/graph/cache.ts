import { readFile, stat } from "node:fs/promises";

interface CacheEntry {
  content: string;
  mtime: number;
}

/**
 * File content cache keyed by absolute path, invalidated by mtime.
 * Avoids re-reading files that haven't changed.
 */
export class FileCache {
  private entries = new Map<string, CacheEntry>();
  private maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  async get(filePath: string): Promise<string | null> {
    try {
      const s = await stat(filePath);
      const mtime = s.mtimeMs;
      const cached = this.entries.get(filePath);

      if (cached && cached.mtime === mtime) {
        this.entries.delete(filePath);
        this.entries.set(filePath, cached);
        return cached.content;
      }

      const content = await readFile(filePath, "utf-8");
      this.set(filePath, content, mtime);
      return content;
    } catch {
      return null;
    }
  }

  /** Manually set a cache entry */
  set(filePath: string, content: string, mtime?: number): void {
    if (this.entries.size >= this.maxSize) {
      // Evict 10% of oldest entries for better batch performance
      const toEvict = Math.max(1, Math.floor(this.maxSize * 0.1));
      const iterator = this.entries.keys();
      for (let i = 0; i < toEvict && this.entries.size >= this.maxSize; i++) {
        const result = iterator.next();
        if (result.done) break;
        this.entries.delete(result.value);
      }
    }
    const mt = mtime ?? Date.now();
    this.entries.set(filePath, { content, mtime: mt });
  }

  /** Invalidate a specific file */
  invalidate(filePath: string): void {
    this.entries.delete(filePath);
  }

  /** Clear entire cache */
  clear(): void {
    this.entries.clear();
  }
}
