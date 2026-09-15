import {
  Building2,
  Check,
  CircleHelp,
  FileText,
  FolderOpen,
  LoaderCircle,
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

const typeIcons = {
  person: Users,
  client: Building2,
  project: FolderOpen,
  article: FileText,
  decision: Check,
  note: CircleHelp,
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
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-2">
        <p className="text-xs font-medium tracking-widest text-primary">
          {eyebrow}
        </p>
        <h1 className="font-serif text-3xl tracking-tight sm:text-4xl">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
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
    <EmptyRoot>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>
          {title}
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </EmptyRoot>
  );
}
