"use client";
import { Link2, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { linkTypes } from "@/lib/brain/labels";
import { isLinkType, type LinkType } from "@/lib/brain/types";
import type { DraftLink } from "@/lib/workspace/page-draft";
import {
  type ConnectionChoice,
  type ConnectionChoices,
  ConnectionPicker,
} from "./connection-picker";

export function ConnectionsEditor({
  links,
  onChange,
  choices,
  id,
}: {
  links: DraftLink[];
  onChange: (links: DraftLink[]) => void;
  choices: ConnectionChoices;
  id?: string;
}) {
  const [linkTarget, setLinkTarget] = useState<ConnectionChoice | null>(null);
  const [linkType, setLinkType] = useState<LinkType>("relates_to");
  return (
    <>
      <input
        type="hidden"
        name="links"
        value={JSON.stringify(
          links.map(({ targetRef, type, label }) => ({
            targetRef,
            type,
            label,
          })),
        )}
      />
      <div className="space-y-4 border-y py-6">
        <h3 className="flex items-center gap-2 font-medium">
          <Link2 size={16} /> Connections
        </h3>
        <p className="text-sm text-muted-foreground">
          Link this page to related people, projects, or notes.
        </p>
        {links.map((link, index) => (
          <div
            className="flex items-center gap-3 border-b pb-4 text-sm"
            key={`${link.targetRef}-${link.type}`}
          >
            <span className="text-muted-foreground">
              {link.type.replaceAll("_", " ")}
            </span>
            <strong className="min-w-0 wrap-anywhere">
              {link.targetTitle ||
                choices.pages.find((p) => p.id === link.targetRef)?.title ||
                link.targetRef}
            </strong>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto shrink-0"
              aria-label="Remove connection"
              onClick={() => onChange(links.filter((_, i) => i !== index))}
            >
              <X size={15} />
            </Button>
          </div>
        ))}
        <div className="flex flex-col items-stretch gap-4 lg:flex-row lg:items-start">
          <Label className="grid gap-2">
            <span className="sr-only">Relationship type</span>
            <NativeSelect
              value={linkType}
              onChange={(e) => {
                if (isLinkType(e.target.value)) setLinkType(e.target.value);
              }}
            >
              {linkTypes.map((item) => (
                <NativeSelectOption key={item} value={item}>
                  {item.replaceAll("_", " ")}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          <ConnectionPicker
            initialChoices={choices}
            excludeId={id}
            value={linkTarget}
            onChange={setLinkTarget}
          />
          <Button
            type="button"
            variant="outline"
            disabled={
              !linkTarget ||
              links.some(
                (link) =>
                  link.targetRef === linkTarget?.id && link.type === linkType,
              )
            }
            onClick={() => {
              if (!linkTarget) return;
              onChange([
                ...links,
                {
                  targetRef: linkTarget.id,
                  targetTitle: linkTarget.title,
                  type: linkType,
                  label: "",
                },
              ]);
              setLinkTarget(null);
            }}
          >
            <Plus size={15} /> Add
          </Button>
        </div>
      </div>
    </>
  );
}
