import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PageHeading } from "@/components/workspace/primitives";

export default function PageNotFound() {
  return (
    <>
      <PageHeading
        eyebrow="Workspace"
        title="Page not found"
        description="It may have been merged into another page, or the link may be incorrect."
      />
      <Button asChild variant="outline">
        <Link href="/">Back to all pages</Link>
      </Button>
    </>
  );
}
