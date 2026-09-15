import type { Metadata } from "next";
import { Library } from "@/components/workspace/library";

export const metadata: Metadata = { title: "Projects | Brain" };

export default function Projects({ searchParams }: PageProps<"/projects">) {
  return <Library type="project" searchParams={searchParams} />;
}
