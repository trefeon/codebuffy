import fs from "node:fs";

export function watchAuthFile(filePath: string, onChange: () => void, intervalMs = 2000): () => void {
  let lastMtime = 0;
  try {
    const st = fs.statSync(filePath);
    lastMtime = st.mtimeMs;
  } catch {
    lastMtime = 0;
  }

  const timer = setInterval(() => {
    fs.stat(filePath, (err, stat) => {
      if (err) return;
      if (stat.mtimeMs !== lastMtime) {
        lastMtime = stat.mtimeMs;
        onChange();
      }
    });
  }, intervalMs);

  // Allow process to exit even if watcher is still active (parity with watchFile).
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref!();
  }

  return () => clearInterval(timer);
}
