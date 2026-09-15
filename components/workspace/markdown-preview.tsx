"use client";

import { Markdown } from "@/components/markdown";

export default function MarkdownPreview({ markdown }: { markdown: string }) {
  return <Markdown markdown={markdown} />;
}
