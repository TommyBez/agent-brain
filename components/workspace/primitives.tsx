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
import { Card } from "@/components/ui/card";

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
    <div className="page-heading flex items-center justify-between gap-5 mb-[35px] min-[1600px]:mb-[45px] max-[740px]:mb-7 max-[460px]:gap-[10px]">
      <div>
        <span className="eyebrow text-[10px] font-semibold tracking-[.16em] text-primary">
          {eyebrow}
        </span>
        <h1>
          {title}
          <span className="heading-dot text-[#839567]">.</span>
        </h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
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
      className="loading-state flex justify-center items-center gap-3 text-[#839274] min-h-[210px] text-xs"
    >
      <LoaderCircle size={20} className="spin" />
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
    <Card className="empty-state items-center text-center px-6 py-12">
      <span className="empty-symbol size-16 rounded-full flex items-center justify-center text-primary bg-secondary">
        {icon}
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </Card>
  );
}
