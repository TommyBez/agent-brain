import { ArrowUpRight, LockKeyhole } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SignInForm } from "./sign-in-form";
import { Wordmark } from "./wordmark";

export function AuthGate({
  configured,
  form,
}: {
  configured: boolean;
  form?: ReactNode;
}) {
  return (
    <main className="flex min-h-svh flex-col px-5 py-8 sm:px-10">
      <header className="flex items-center justify-between">
        <Link className="inline-flex" href="/" aria-label="a native brain home">
          <Wordmark />
        </Link>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <LockKeyhole className="size-3.5" />
          Personal workspace
        </span>
      </header>
      <section
        className="flex flex-1 items-center justify-center py-12"
        aria-label={configured ? "Sign in" : "Set up a native brain"}
      >
        <Card className="w-full max-w-[440px] gap-8 py-8 sm:py-10">
          <CardHeader className="gap-3 px-7 sm:px-10">
            <CardTitle>
              <h1 className="text-3xl font-semibold tracking-tight">
                {configured ? "Welcome back" : "Set up your workspace"}
              </h1>
            </CardTitle>
            <CardDescription>
              {configured
                ? "Sign in to your personal knowledge workspace."
                : "Connect your workspace to your infrastructure to begin."}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-7 sm:px-10">
            {configured ? (
              (form ?? <SignInForm />)
            ) : (
              <div className="space-y-6">
                <ol className="list-decimal space-y-4 pl-5 text-sm">
                  <li>
                    <strong className="block">Connect your database</strong>
                    <p className="text-muted-foreground">
                      Add your Neon connection and run the migrations.
                    </p>
                  </li>
                  <li>
                    <strong className="block">Configure authentication</strong>
                    <p className="text-muted-foreground">
                      Set the application URL, auth secret, and owner email.
                    </p>
                  </li>
                  <li>
                    <strong className="block">Create your account</strong>
                    <p className="text-muted-foreground">
                      Run the owner bootstrap command in the setup guide.
                    </p>
                  </li>
                </ol>
                <Button variant="outline" asChild>
                  <a
                    href="https://github.com/TommyBez/agent-brain#deployment"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Deployment instructions <ArrowUpRight />
                  </a>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
