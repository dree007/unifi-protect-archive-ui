"use client";

import { useI18n } from "@/i18n/provider";
import { Cctv, GitMerge, HardDrive, Sparkles } from "lucide-react";

import { HUE_CLASSES } from "@/components/common/tone";

const STEPS = [
  {
    icon: HardDrive,
    hue: HUE_CLASSES.butter.ink,
    title: "onboarding.scan",
    text: "onboarding.scanBody",
    command: "npm run archive:scan",
  },
  {
    icon: Cctv,
    hue: HUE_CLASSES.sky.ink,
    title: "onboarding.cameras",
    text: "onboarding.camerasBody",
    command: "npm run protect:sync-cameras",
  },
  {
    icon: GitMerge,
    hue: HUE_CLASSES.sage.ink,
    title: "onboarding.reconcile",
    text: "onboarding.reconcileBody",
    command: "npm run archive:reconcile",
  },
] as const;

/** Friendly first-run state when the database holds no archive data yet. */
export function Onboarding() {
  const { t } = useI18n();
  return (
    <section aria-labelledby="onboarding-title" className="surface-card overflow-hidden">
      <div className="flex flex-col gap-2 bg-surface-muted px-6 py-8 sm:px-8">
        <span className="grid size-12 place-items-center rounded-sm bg-violet-soft text-violet-ink">
          <Sparkles aria-hidden className="size-6" />
        </span>
        <h2 id="onboarding-title" className="mt-3 type-heading">
          {t("onboarding.empty")}
        </h2>
        <p className="max-w-xl text-[0.9375rem] text-muted-foreground">
          {t("onboarding.description")}
        </p>
      </div>
      <ol className="grid grid-cols-1 gap-3 p-4 sm:p-6 lg:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.command} className="surface-inset flex flex-col gap-3 p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-card text-sm font-medium text-foreground">
                {index + 1}
              </span>
              <step.icon aria-hidden className={`size-5 ${step.hue}`} />
            </div>
            <div className="flex flex-col gap-1">
              <h3 className="font-medium">{t(step.title)}</h3>
              <p className="text-sm text-muted-foreground">{t(step.text)}</p>
            </div>
            <code className="mt-auto rounded-xs bg-card px-3 py-2 font-mono text-[0.8125rem] text-graphite [overflow-wrap:anywhere]">
              {step.command}
            </code>
          </li>
        ))}
      </ol>
      <p className="px-6 pb-6 text-sm text-muted-foreground sm:px-8">
        {t("onboarding.collector")}{" "}
        <code className="rounded-xs bg-surface-muted px-1.5 py-0.5 font-mono text-xs">npm run protect:collect</code>
      </p>
    </section>
  );
}
