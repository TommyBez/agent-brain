import { EyeOff } from "lucide-react";
import Link from "next/link";
import { excludeFromKeeperAction } from "@/app/(workspace)/actions/tasks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getKeeperExclusions } from "@/lib/workspace/tasks-data";
import { ActionButton } from "./action-state";

/** Operations: pages the task hygiene never reads, with "Include again". */
export async function KeeperExclusions() {
  const pages = await getKeeperExclusions();
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <EyeOff className="size-5 shrink-0" aria-hidden="true" />
          Excluded from the task hygiene
        </CardTitle>
        <CardDescription>
          The task hygiene never reads these pages for hygiene suggestions.
          Exclude a confidential page from its Connections panel.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {pages.length ? (
          <ul className="divide-y">
            {pages.map((page) => (
              <li
                key={page.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
              >
                <Link
                  href={`/pages/${page.id}`}
                  className="min-w-0 flex-1 text-sm font-medium wrap-anywhere hover:underline"
                >
                  {page.title}
                </Link>
                <span className="text-xs text-muted-foreground capitalize">
                  {page.type}
                </span>
                <ActionButton
                  size="xs"
                  variant="outline"
                  errorClassName="basis-full"
                  action={excludeFromKeeperAction.bind(null, page.id, false)}
                >
                  Include again
                </ActionButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No pages are excluded. The task hygiene reads every page.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
