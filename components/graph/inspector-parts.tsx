import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { entityTypes } from "@/lib/brain/labels";
import type { PageType } from "@/lib/brain/types";
import type { GraphNode } from "@/lib/graph/model";
import { pageHref } from "@/lib/workspace/urls";
import { EntityIcon } from "../workspace/primitives";

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-medium tracking-widest text-muted-foreground">
      {children}
    </h3>
  );
}

export function typeLabel(type: PageType) {
  return entityTypes.find((item) => item.id === type)?.label ?? type;
}

export function NodeButton({
  node,
  caption,
  onSelect,
}: {
  node: GraphNode;
  caption: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className={`entity-${node.type} flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none`}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <EntityIcon type={node.type} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-foreground">{node.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {caption}
          </span>
        </span>
      </button>
      <Button variant="ghost" size="icon-sm" asChild>
        <Link href={pageHref(node.id)} aria-label={`Open ${node.title}`}>
          <ArrowUpRight />
        </Link>
      </Button>
    </div>
  );
}
