import { useEffect, useState } from "react";

// A loaded document/audio file must not need an expired signed URL for later ranges.
export function usePreviewBlobUrl(source: string) {
  const [result, setResult] = useState<{ source: string; url: string | null; failed: boolean }>({
    source,
    url: null,
    failed: false,
  });
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void fetch(source, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("File preview request failed");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setResult({ source, url: objectUrl, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ source, url: null, failed: true });
      });
    return () => {
      controller.abort();
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [source]);
  return result.source === source ? result : { source, url: null, failed: false };
}
