// Read-only views over the office state that several panels share.

import type { OfficeState } from '../../shared/scene-api';
import type { AgentPresence, ChatMessage, Department, DepartmentColor, PermissionRequest, SessionState } from '../../shared/types';

/** The department whose room panel is open: the selected one, or the selected agent's. */
export function openDepartment(state: OfficeState): Department | null {
  const selected = state.selected;
  if (!selected) return null;
  const id = selected.kind === 'department' ? selected.id : state.agents.find((a) => a.id === selected.id)?.department;
  return id ? (state.config.departments.find((d) => d.id === id) ?? null) : null;
}

/** "Development manager". The lobby's general manager is already named "General manager". */
export function managerTitle(department: Department): string {
  return department.kind === 'lobby' ? department.name : `${department.name} manager`;
}

/**
 * Who a chat message is from, as the chat prints it. The person typing is always "You": the role is `user`, and a
 * history line that still carries the name it had before the rename (`founder`) reads the same way.
 */
export function speakerLabel(message: Pick<ChatMessage, 'role' | 'fromName'>, department: Department): string {
  switch (message.role as string) {
    case 'user':
    case 'founder':
      return 'You';
    case 'manager':
      return managerTitle(department);
    case 'colleague':
      return message.fromName ?? 'A colleague';
    default:
      return 'Office';
  }
}

export function sessionOf(state: OfficeState, department: string): SessionState | null {
  return state.sessions.find((s) => s.department === department) ?? null;
}

export function managerOf(state: OfficeState, department: string): AgentPresence | null {
  return state.agents.find((a) => a.id === `manager:${department}`) ?? null;
}

/** The manager first, then the subagents in the order they started. */
export function agentsOf(state: OfficeState, department: string): AgentPresence[] {
  return state.agents
    .filter((a) => a.department === department)
    .sort((a, b) => (a.kind === b.kind ? a.startedAt.localeCompare(b.startedAt) : a.kind === 'manager' ? -1 : 1));
}

export function approvalsOf(state: OfficeState, department: string): PermissionRequest[] {
  return state.permissions.filter((p) => p.department === department).sort((a, b) => a.at.localeCompare(b.at));
}

/** A turn is running: the session says so, the manager is at work, or a reply is still streaming. */
export function isBusy(state: OfficeState, department: string): boolean {
  const session = sessionOf(state, department);
  if (session && (session.status === 'busy' || session.status === 'waiting')) return true;
  const manager = managerOf(state, department);
  if (manager && (manager.status === 'thinking' || manager.status === 'working' || manager.status === 'waiting')) return true;
  return state.messages.some((m) => m.department === department && m.streaming);
}

/** The session is running or about to: Stop applies, Start does not. */
export function isOn(session: SessionState | null): boolean {
  return !!session && session.status !== 'off' && session.status !== 'error';
}

export function canSend(state: OfficeState): boolean {
  return state.connection === 'live' || state.connection === 'mock';
}

export function colorVar(color: DepartmentColor | string): string {
  return `var(--dept-${color})`;
}
