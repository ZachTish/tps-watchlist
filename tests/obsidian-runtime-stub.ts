export class App {}
export class ItemView {}
export class Modal {}
export class Notice {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class TFile {}
export class WorkspaceLeaf {}

export const Platform = { isMobile: false };

export function normalizePath(path: string): string {
  return path;
}

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is unavailable in unit tests.");
}

export function setIcon(): void {}
