import {
  Building2,
  Check,
  FileText,
  FolderOpen,
  LoaderCircle,
  NotebookPen,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  Empty as EmptyRoot,
  EmptyTitle,
} from "@/components/ui/empty";

export const typeIcons = {
  person: Users,
  client: Building2,
  project: FolderOpen,
  article: FileText,
  decision: Check,
  note: NotebookPen,
};

export function EntityIcon({
  type,
  size = 17,
}: {
  type: string;
  size?: number;
}) {
  const Icon = typeIcons[type as keyof typeof typeIcons] ?? FileText;
  return <Icon size={size} strokeWidth={1.6} />;
}

export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-9 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-4 sm:mb-12">
      <p className="col-span-2 text-[10px] font-medium tracking-[0.16em] uppercase text-muted-foreground">
        {eyebrow}
      </p>
      <h1 className="min-w-0 font-serif text-4xl font-normal tracking-[-0.045em] sm:text-5xl sm:leading-tight lg:text-[3.5rem]">
        {title}
      </h1>
      {children}
      {description && (
        <p className="col-span-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </header>
  );
}

export function Loading({
  label = "Opening your knowledge…",
}: {
  label?: string;
}) {
  return (
    <output
      aria-live="polite"
      className="flex min-h-48 items-center justify-center gap-3 text-sm text-muted-foreground"
    >
      <LoaderCircle size={20} className="animate-spin" />
      {label}
    </output>
  );
}

export function Empty({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <EmptyRoot className="rounded-2xl border border-dashed bg-card px-6 py-16">
      <EmptyHeader>
        <EmptyMedia
          variant="icon"
          className="mb-3 size-14 rounded-2xl bg-secondary text-primary"
        >
          {icon}
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>
          {title}
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </EmptyRoot>
  );
}
