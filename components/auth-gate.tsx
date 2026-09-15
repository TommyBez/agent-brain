import { ArrowUpRight, CircleCheck } from "lucide-react";
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

export function AuthGate({
  configured,
  form,
}: {
  configured: boolean;
  form?: ReactNode;
}) {
  return (
    <main className="grid min-h-svh md:grid-cols-2">
      <section className="flex flex-col gap-12 bg-muted p-6 md:p-12">
        <Link
          className="font-serif text-3xl font-semibold"
          href="/"
          aria-label="Brain home"
        >
          brain
        </Link>
        <div className="my-auto max-w-lg space-y-6">
          <h1 className="font-serif text-4xl tracking-tight md:text-5xl">
            Good thoughts deserve a longer life.
          </h1>
          <p className="text-muted-foreground">
            A second brain that grows with your conversations. One page for each
            person, project, and idea. Connected, considered, and yours.
          </p>
        </div>
        <ul className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          {["Your infrastructure", "Any agent", "Open by design"].map(
            (label) => (
              <li key={label} className="flex items-center gap-2">
                <CircleCheck className="size-4" />
                {label}
              </li>
            ),
          )}
        </ul>
      </section>
      <section
        className="flex items-center justify-center p-6 md:p-12"
        aria-label={configured ? "Sign in" : "Set up Brain"}
      >
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>
              <h2>{configured ? "Welcome back." : "A home for your brain."}</h2>
            </CardTitle>
            <CardDescription>
              {configured
                ? "Sign in to pick up the thread."
                : "Connect your workspace to your infrastructure to begin."}
            </CardDescription>
          </CardHeader>
          <CardContent>
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
