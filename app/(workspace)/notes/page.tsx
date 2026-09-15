import type { Metadata } from "next";
import { Library } from "@/components/workspace/library";

export const metadata: Metadata = { title: "Notes | Brain" };

export default function Notes({ searchParams }: PageProps<"/notes">) {
  return <Library type="note" searchParams={searchParams} />;
}
