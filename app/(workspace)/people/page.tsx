import type { Metadata } from "next";
import { Library } from "@/components/workspace/library";

export const metadata: Metadata = { title: "People | Brain" };

export default function People({ searchParams }: PageProps<"/people">) {
  return <Library type="person" searchParams={searchParams} />;
}
