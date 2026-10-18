export function HarnessLogo({ className }: { readonly className: string }) {
  return (
    <img
      src="/tritonai-logo.png"
      alt=""
      aria-hidden
      draggable={false}
      width={16}
      height={16}
      className={className}
    />
  );
}
