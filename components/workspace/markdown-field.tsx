"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
export const MarkdownPreview = dynamic(() => import("./markdown-preview"), {
  loading: () => (
    <output className="block text-sm text-muted-foreground">
      Loading preview…
    </output>
  ),
});
export function MarkdownField({
  markdown,
  onChange,
}: {
  markdown: string;
  onChange: (value: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <>
      <input type="hidden" name="markdown" value={markdown} />
      <Tabs
        value={preview ? "preview" : "write"}
        onValueChange={(value) => setPreview(value === "preview")}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor="markdown-content">Page content</Label>
          <TabsList>
            <TabsTrigger value="write">Write</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          value="preview"
          className="markdown-body reading-body min-h-[32rem] border-y bg-card p-6 sm:p-10"
        >
          {preview && (
            <MarkdownPreview
              markdown={markdown || "*Nothing to preview yet.*"}
            />
          )}
        </TabsContent>
        <TabsContent value="write">
          <Textarea
            id="markdown-content"
            className="min-h-[32rem] resize-y rounded-none border-x-0 bg-card p-6 font-mono leading-relaxed shadow-none sm:p-10"
            value={markdown}
            onChange={(e) => onChange(e.target.value)}
            placeholder={
              "## Overview\n\nWhat is useful to remember?\n\n## Context\n\nAdd facts, sources, and the decisions behind them."
            }
            required
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
