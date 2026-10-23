import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CirclePause,
  CircleOff,
  HeartPulse,
  KeyRound,
  Loader,
  PlugZap,
  Power,
  Unplug,
} from "lucide-react";

import type { JobStatusKind, ProtectStatusKind, ScanRunModel, WorkerStatusKind } from "@/lib/view-models";

import type { MessageKey } from "@/i18n/core";
import type { StatusBadge } from "./status-parts";

/**
 * Labels and tones of every operating state (see tone.ts): sage tint = fine, ember tint =
 * attention, ember ink = error, neutral = deliberately off / not available. "Stale" and
 * "unknown" are never shown as fine.
 */

type TranslatedBadge = Omit<StatusBadge, "label"> & { label: MessageKey };

export const WORKER_BADGES: Record<WorkerStatusKind, TranslatedBadge> = {
  notStarted: { label: "status.notStarted", tone: "neutral", icon: CircleDashed },
  starting: { label: "status.starting", tone: "info", icon: Loader, spin: true },
  running: { label: "status.running", tone: "success", icon: HeartPulse },
  stopping: { label: "status.stopping", tone: "neutral", icon: CirclePause },
  stopped: { label: "status.stopped", tone: "neutral", icon: Power },
  error: { label: "common.error", tone: "danger", icon: CircleAlert },
  stale: { label: "status.stale", tone: "warning", icon: Unplug },
};

export const PROTECT_BADGES: Record<ProtectStatusKind, TranslatedBadge> = {
  noStatus: { label: "status.noStatus", tone: "neutral", icon: CircleDashed },
  disabled: { label: "status.disabled", tone: "neutral", icon: CircleOff },
  notConfigured: { label: "status.disabled", tone: "neutral", icon: CircleOff },
  connecting: { label: "status.connecting", tone: "info", icon: Loader, spin: true },
  connected: { label: "status.connected", tone: "success", icon: PlugZap },
  reconnecting: { label: "status.reconnecting", tone: "warning", icon: Loader, spin: true },
  authenticationError: { label: "status.authError", tone: "danger", icon: KeyRound },
  error: { label: "common.error", tone: "danger", icon: CircleAlert },
  stopped: { label: "status.disconnected", tone: "neutral", icon: Power },
  unknown: { label: "status.unknown", tone: "warning", icon: CircleHelp },
};

export const JOB_BADGES: Record<Exclude<JobStatusKind, "noStatus">, TranslatedBadge> = {
  idle: { label: "status.idle", tone: "neutral", icon: CirclePause },
  running: { label: "status.working", tone: "primary", icon: Loader, spin: true },
  success: { label: "status.success", tone: "success", icon: CircleCheck },
  error: { label: "status.failed", tone: "danger", icon: CircleAlert },
  unknown: { label: "status.interrupted", tone: "warning", icon: CircleHelp },
};

/** Badge from the scan history when no worker status exists (manual `npm run archive:scan`). */
export const SCAN_RUN_BADGES: Record<ScanRunModel["status"], TranslatedBadge> = {
  completed: { label: "status.completed", tone: "success", icon: CircleCheck },
  failed: { label: "status.failed", tone: "danger", icon: CircleAlert },
  running: { label: "status.working", tone: "primary", icon: Loader, spin: true },
};
