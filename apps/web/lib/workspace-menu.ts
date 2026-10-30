export function workspaceMenuPortalTarget(trigger: Pick<HTMLElement, "closest">): HTMLElement | null {
  return trigger.closest<HTMLElement>('.rail-drawer[role="dialog"]') ?? trigger.closest<HTMLElement>(".app-shell");
}
