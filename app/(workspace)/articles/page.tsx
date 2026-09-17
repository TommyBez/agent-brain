import type { Metadata } from "next";
import { Library } from "@/components/workspace/library";

export const metadata: Metadata = { title: "Articles · a native brain" };

export default function Articles({ searchParams }: PageProps<"/articles">) {
  return <Library type="article" searchParams={searchParams} />;
}
