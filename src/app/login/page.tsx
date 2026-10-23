import type { Metadata } from "next";
import { cookies } from "next/headers";

import { LanguageToggle } from "@/components/layout/language-toggle";
import { LogoMark } from "@/components/layout/logo-mark";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { getI18n } from "@/i18n/server";
import { parseTheme, THEME_COOKIE } from "@/lib/ui-preferences";
import { safeNextPath } from "@/server/auth/login";

import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t("login.title") };
}

/** Only reachable with APP_LOGIN_USERNAME/APP_LOGIN_PASSWORD set; otherwise src/proxy.ts sends "/". */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const [{ t }, { next }, cookieStore] = await Promise.all([getI18n(), searchParams, cookies()]);
  return (
    <main id="main" className="relative grid min-h-dvh place-items-center px-4 py-24">
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <ThemeToggle theme={parseTheme(cookieStore.get(THEME_COOKIE)?.value)} variant="compact" />
        <LanguageToggle />
      </div>
      <section aria-labelledby="login-title" className="surface-card flex w-full max-w-sm flex-col gap-6 p-6 sm:p-8">
        <div className="flex flex-col gap-4">
          <LogoMark className="size-12" />
          <div className="flex flex-col gap-1">
            <h1 id="login-title" className="type-title">{t("login.title")}</h1>
            <p className="text-[0.9375rem] text-muted-foreground">{t("login.description")}</p>
          </div>
        </div>
        <LoginForm next={safeNextPath(Array.isArray(next) ? next[0] : next)} />
      </section>
    </main>
  );
}
