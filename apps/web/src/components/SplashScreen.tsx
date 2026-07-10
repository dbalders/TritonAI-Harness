export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-24 items-center justify-center"
        aria-label="TritonAI Harness splash screen"
      >
        <img alt="TritonAI Harness" className="size-16 object-contain" src="/tritonai-logo.png" />
      </div>
    </div>
  );
}
