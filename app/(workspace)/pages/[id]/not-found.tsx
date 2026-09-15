import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/workspace/primitives";

export default function PageNotFound() {
  return (
    <>
      <Empty
        icon={<FileQuestion size={27} />}
        title="Page not found."
        description="This page or saved version is not available in your workspace."
      />
      <Button variant="outline" asChild>
        <Link href="/">Back to all pages</Link>
      </Button>
    </>
  );
}
