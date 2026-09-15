import { Library } from "@/components/workspace/library";
import type { RouteSearchParams } from "@/lib/workspace/urls";

export default function Home({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  return <Library searchParams={searchParams} />;
}
