import { FolderIcon } from "lucide-react";

export function NewThreadProjectContext({ projectName }: { readonly projectName: string }) {
  return (
    <div
      data-chat-composer-project-context="true"
      className="flex min-w-0 items-center gap-2 rounded-t-[19px] border-b border-border/65 bg-muted/20 px-4 py-2.5 text-sm font-medium text-foreground"
      title={projectName}
    >
      <FolderIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{projectName}</span>
    </div>
  );
}
