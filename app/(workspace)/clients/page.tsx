import type { Metadata } from "next";
import { Library } from "@/components/workspace/library";

export const metadata: Metadata = { title: "Clients | Brain" };

export default function Clients({ searchParams }: PageProps<"/clients">) {
  return <Library type="client" searchParams={searchParams} />;
}
