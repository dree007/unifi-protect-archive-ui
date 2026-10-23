"use client";

import { useActionState } from "react";
import { LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";

import { signIn, type LoginState } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const { t } = useI18n();
  const [state, action, pending] = useActionState<LoginState, FormData>(signIn, { error: null, username: "" });
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="login-username">{t("login.username")}</Label>
        <Input id="login-username" name="username" defaultValue={state.username} autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus={state.error === null}
          aria-invalid={state.error === "invalid" || undefined} aria-describedby={state.error ? "login-error" : undefined} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="login-password">{t("login.password")}</Label>
        <Input id="login-password" name="password" type="password" autoComplete="current-password" required autoFocus={state.error !== null}
          aria-invalid={state.error === "invalid" || undefined} aria-describedby={state.error ? "login-error" : undefined} />
      </div>
      {state.error && (
        <p id="login-error" role="alert" className="rounded-md bg-danger-soft px-4 py-3 text-sm text-danger-strong">
          {state.error === "locked" ? t("login.locked") : t("login.invalid")}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending} className="mt-2">
        <LogIn aria-hidden />
        {t("login.submit")}
      </Button>
    </form>
  );
}
