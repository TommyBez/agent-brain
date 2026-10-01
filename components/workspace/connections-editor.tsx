"use client";
import { Link2, Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
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
  const fieldId = useId();
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
      <div className="border-y py-6">
        <FieldSet>
          <FieldLegend className="flex items-center gap-2">
            <Link2 size={16} /> Connections
          </FieldLegend>
          <FieldDescription>
            Link this page to related people, projects, or notes.
          </FieldDescription>
          <ItemGroup className="gap-2 empty:hidden">
            {links.map((link, index) => (
              <Item
                role="listitem"
                variant="outline"
                size="sm"
                key={`${link.targetRef}-${link.type}`}
              >
                <ItemContent className="min-w-0">
                  <ItemDescription>
                    {link.type.replaceAll("_", " ")}
                  </ItemDescription>
                  <ItemTitle className="wrap-anywhere">
                    {link.targetTitle ||
                      choices.pages.find((p) => p.id === link.targetRef)
                        ?.title ||
                      link.targetRef}
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove connection"
                    onClick={() =>
                      onChange(links.filter((_, i) => i !== index))
                    }
                  >
                    <X />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
          {/* Not a FieldGroup: Chrome skips relayout of its container-query
            children when the connection list above grows. */}
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
            <Field className="lg:w-48">
              <FieldLabel htmlFor={`${fieldId}-type`}>Relationship</FieldLabel>
              <NativeSelect
                id={`${fieldId}-type`}
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
            </Field>
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor={`${fieldId}-target`}>Page</FieldLabel>
              <ConnectionPicker
                id={`${fieldId}-target`}
                initialChoices={choices}
                excludeId={id}
                value={linkTarget}
                onChange={setLinkTarget}
              />
            </Field>
            <Button
              type="button"
              variant="outline"
              className="lg:w-auto"
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
              <Plus /> Add
            </Button>
          </div>
        </FieldSet>
      </div>
    </>
  );
}
