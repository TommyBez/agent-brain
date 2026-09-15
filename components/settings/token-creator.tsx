"use client";

import { Check, KeyRound, LoaderCircle, Plus } from "lucide-react";
import { useId, useState } from "react";
import { CopyButton } from "@/components/settings/copy-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { createTokenAction } from "@/lib/workspace/settings-actions";

export function TokenCreator() {
  const fieldId = useId();
  const [creating, setCreating] = useState(false);
  const [rawToken, setRawToken] = useState("");
  const [error, setError] = useState("");
  const [writing, setWriting] = useState(false);
  const [scopes, setScopes] = useState(["brain:read", "brain:write"]);

  async function createToken(form: FormData) {
    setWriting(true);
    setError("");
    try {
      const result = await createTokenAction(form);
      if (result.error) setError(result.error);
      else if (result.token) {
        setRawToken(result.token);
        setCreating(false);
      }
    } catch {
      setError("Unable to create token. Try again.");
    } finally {
      setWriting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="mb-5"
        disabled={writing}
        onClick={() => {
          setCreating(!creating);
          setRawToken("");
          setError("");
        }}
      >
        <Plus /> New token
      </Button>
      {error && (
        <p className="mb-4 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {rawToken && (
        <Card className="mb-5">
          <CardHeader>
            <CardTitle>Save your token now.</CardTitle>
            <CardDescription>
              This is the only time the full token will be shown.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={rawToken}
                aria-label="New agent token"
                className="font-mono"
              />
              <CopyButton value={rawToken} label="Copy new token" />
            </div>
            <Button
              type="button"
              variant="link"
              onClick={() => setRawToken("")}
            >
              I have saved it <Check />
            </Button>
          </CardContent>
        </Card>
      )}
      {creating && (
        <Card className="mb-5">
          <CardContent>
            <form className="space-y-6" action={createToken}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor={`${fieldId}-name`}>Agent name</Label>
                  <Input
                    id={`${fieldId}-name`}
                    name="name"
                    placeholder="e.g. Nightly consolidation"
                    maxLength={80}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`${fieldId}-days`}>Expires in</Label>
                  <NativeSelect
                    id={`${fieldId}-days`}
                    name="days"
                    defaultValue="90"
                  >
                    <NativeSelectOption value="7">7 days</NativeSelectOption>
                    <NativeSelectOption value="30">30 days</NativeSelectOption>
                    <NativeSelectOption value="90">90 days</NativeSelectOption>
                    <NativeSelectOption value="365">
                      365 days
                    </NativeSelectOption>
                  </NativeSelect>
                </div>
              </div>
              <fieldset className="flex flex-wrap gap-6">
                <legend className="mb-3 text-sm font-medium">
                  Permissions
                </legend>
                {[
                  {
                    value: "brain:read",
                    label: "Read",
                    help: "Search and retrieve knowledge",
                  },
                  {
                    value: "brain:write",
                    label: "Write",
                    help: "Create and update pages",
                  },
                  {
                    value: "brain:maintain",
                    label: "Maintain",
                    help: "Perform consolidation work",
                  },
                ].map((scope) => (
                  <div className="flex items-start gap-2" key={scope.value}>
                    <Checkbox
                      id={`${fieldId}-${scope.value}`}
                      name="scopes"
                      value={scope.value}
                      checked={scopes.includes(scope.value)}
                      onCheckedChange={(checked) =>
                        setScopes(
                          checked === true
                            ? [...scopes, scope.value]
                            : scopes.filter((s) => s !== scope.value),
                        )
                      }
                    />
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${fieldId}-${scope.value}`}>
                        {scope.label}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {scope.help}
                      </p>
                    </div>
                  </div>
                ))}
              </fieldset>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  variant="default"
                  disabled={writing || !scopes.length}
                >
                  {writing ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <KeyRound />
                  )}{" "}
                  Create token
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={writing}
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </>
  );
}
