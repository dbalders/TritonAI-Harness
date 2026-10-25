import { useEffect, useEffectEvent } from "react";
import { usePreviewBlobUrl } from "~/hooks/usePreviewBlobUrl";

export function AudioPreview(props: {
  readonly src: string;
  readonly name: string;
  readonly onError?: () => void;
}) {
  const preview = usePreviewBlobUrl(props.src);
  const onError = useEffectEvent(() => props.onError?.());
  useEffect(() => {
    if (preview.failed) onError();
  }, [preview.failed]);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <audio
        controls
        preload="metadata"
        src={preview.url ?? undefined}
        aria-label={props.name}
        className="w-full max-w-xl"
        onError={props.onError}
      />
    </div>
  );
}
