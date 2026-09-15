"use client";

import { Check, KeyRound, LoaderCircle, Plus } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/settings/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { createTokenAction } from "@/lib/workspace/settings-actions";

export function TokenCreator() {
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
        <Plus size={15} /> New token
      </Button>
      {error && (
        <p className="mb-4 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {rawToken && (
        <div className="token-reveal [border:1px_solid_#c8d9b0] p-[22px] rounded-[6px] [background:#edf5e1] mb-[22px]">
          <strong>Save your token now.</strong>
          <p>This is the only time the full token will be shown.</p>
          <div className="copy-field [border:1px_solid_#d2ddc0] rounded-[5px] [background:#fffef9] p-[9px_11px_9px_15px] flex items-center justify-between gap-[15px] m-[20px_0_15px] max-[460px]:pl-[10px]">
            <code>{rawToken}</code>
            <CopyButton value={rawToken} label="Copy new token" />
          </div>
          <Button
            type="button"
            variant="ghost"
            className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
            onClick={() => setRawToken("")}
          >
            I have saved it <Check size={14} />
          </Button>
        </div>
      )}
      {creating && (
        <form
          className="token-form p-[22px] [border:1px_solid_#dce4cf] rounded-[6px] [background:#f4f7ed] mb-[22px]"
          action={createToken}
        >
          <div className="editor-fields grid grid-cols-[2fr_1fr] gap-[18px] mb-[23px]">
            <Label>
              Agent name
              <Input
                name="name"
                placeholder="e.g. Nightly consolidation"
                maxLength={80}
                required
              />
            </Label>
            <Label>
              Expires in
              <NativeSelect name="days" defaultValue="90">
                <NativeSelectOption value="7">7 days</NativeSelectOption>
                <NativeSelectOption value="30">30 days</NativeSelectOption>
                <NativeSelectOption value="90">90 days</NativeSelectOption>
                <NativeSelectOption value="365">365 days</NativeSelectOption>
              </NativeSelect>
            </Label>
          </div>
          <fieldset>
            <legend>Permissions</legend>
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
              <Label
                className="scope-option flex flex-row gap-2 items-start [font-size:9px] [color:#91a07e]"
                key={scope.value}
              >
                <Input
                  type="checkbox"
                  name="scopes"
                  value={scope.value}
                  checked={scopes.includes(scope.value)}
                  onChange={(event) =>
                    setScopes(
                      event.target.checked
                        ? [...scopes, scope.value]
                        : scopes.filter((s) => s !== scope.value),
                    )
                  }
                />
                <span>
                  <strong>{scope.label}</strong>
                  {scope.help}
                </span>
              </Label>
            ))}
          </fieldset>
          <div className="button-group flex gap-[10px] items-center">
            <Button
              type="submit"
              variant="default"
              className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap primary"
              disabled={writing || !scopes.length}
            >
              {writing ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <KeyRound size={15} />
              )}{" "}
              Create token
            </Button>
            <Button
              type="button"
              variant="outline"
              className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap"
              disabled={writing}
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
