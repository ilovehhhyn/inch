// Names the IPC channels and the API object the preload script gives the renderer; the one place both sides agree.
import type { StartupErrorInfo } from "./startup-error";

export const IPC_CHANNELS = {
  startupStatus: "startup:status",
  copyText: "clipboard:copy",
} as const;

export type StartupStatus = Readonly<{ ok: true; codexVersion: string }> | Readonly<{ ok: false; error: StartupErrorInfo }>;

export type MarginApi = Readonly<{
  startupStatus(): Promise<StartupStatus>;
  copyText(text: string): Promise<void>;
}>;
