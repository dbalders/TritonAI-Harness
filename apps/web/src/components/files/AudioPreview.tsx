import { useEffect, useEffectEvent, useState } from "react";
import { usePreviewBlobUrl } from "~/hooks/usePreviewBlobUrl";

export function AudioPreview(props: {
  readonly src: string;
  readonly name: string;
  readonly revision?: string | null;
  readonly onError?: () => void;
}) {
  const revision = props.revision ?? null;
  const [source, setSource] = useState({ src: props.src, revision });
  const [playing, setPlaying] = useState(false);
  // Re-signing keeps the downloaded audio; changed files load once playback pauses.
  if (source.revision !== revision && !playing) setSource({ src: props.src, revision });
  const preview = usePreviewBlobUrl(source.src);
  if (preview.failed && source.src !== props.src) setSource({ src: props.src, revision });
  const failed = preview.failed && source.src === props.src;
  const handleError = () => {
    setPlaying(false);
    if (source.src !== props.src) setSource({ src: props.src, revision });
    else props.onError?.();
  };
  const onError = useEffectEvent(() => props.onError?.());
  useEffect(() => {
    if (failed) onError();
  }, [failed]);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <audio
        controls
        preload="metadata"
        src={preview.url ?? undefined}
        aria-label={props.name}
        className="w-full max-w-xl"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={handleError}
      />
    </div>
  );
}
