import type { Metadata } from "next";
import { Library } from "@/components/workspace/library";

export const metadata: Metadata = { title: "People · a native brain" };

export default function People({ searchParams }: PageProps<"/people">) {
  return <Library type="person" searchParams={searchParams} />;
}
