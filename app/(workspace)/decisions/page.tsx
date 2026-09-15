import type { Metadata } from "next";
import { Library } from "@/components/workspace/library";

export const metadata: Metadata = { title: "Decisions | Brain" };

export default function Decisions({ searchParams }: PageProps<"/decisions">) {
  return <Library type="decision" searchParams={searchParams} />;
}
