export interface AudioControllableWebview {
  readonly setAudioMuted: (muted: boolean) => void;
}

export function syncHostedBrowserWebviewAudio(
  webview: AudioControllableWebview,
  visible: boolean,
): void {
  webview.setAudioMuted(!visible);
}
