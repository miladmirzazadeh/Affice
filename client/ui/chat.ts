// The face to face chat with a department's manager: a red line while approvals are off, approval
// cards on top, the conversation with streaming replies (a colleague's message shows as from its
// sender), the composer (Enter sends, Shift+Enter adds a line, Interrupt while a turn runs), and a
// footer with the Bypass approvals switch, the model, the session id and Start or Stop session.

import type { OfficeState } from '../../shared/scene-api';
import type { ChatMessage, ClientCommand, Department, PermissionPart, PermissionRequest, SessionStatus } from '../../shared/types';
import type { Store } from '../state/store';
import type { UiStore } from '../state/ui';
import { h, icon, setAttr, setText, syncList } from './dom';
import { approvalMeta, approvalParts, cutNote, isLong } from './approval';
import { approvalsOf, canSend, isBusy, isOn, managerOf, managerTitle, sessionOf, speakerLabel } from './derive';
import { clock, modelName, toolName } from './format';
import type { Toasts } from './toast';

export interface Chat {
  el: HTMLElement;
  update(state: OfficeState, department: Department): void;
  /** Scrolls to the newest message; the room calls it when the chat comes back into view. */
  scrollToEnd(): void;
  focus(): void;
}

/** Messages from the same side closer than this share one header. */
const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 48;
/** An answered approval stays disabled this long while the server confirms; then it can be tried again. */
const PENDING_MS = 8000;
const COMPOSER_MAX_PX = 168;
/** After the switch is used the session restarts; a stop seen in this window is part of that. */
const RESTART_MS = 8000;
const BUSY_REASON = 'Wait for the manager to finish, or interrupt it, then switch.';

export function createChat(deps: { store: Store; ui: UiStore; toasts: Toasts }): Chat {
  let department: Department | null = null;
  let lastState: OfficeState | null = null;
  /** The reader is at the newest message; new text and a shrinking log keep it in view. */
  let pinned = true;
  const pending = new Map<string, number>();
  const rendered = new WeakMap<HTMLElement, string>();
  /** Departments whose session has had the bypass warning confirmed. A stopped session forgets it. */
  const warned = new Set<string>();
  const restarting = new Map<string, number>();
  const lastStatus = new Map<string, SessionStatus>();
  deps.store.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return;
    for (const session of state.sessions) {
      const was = lastStatus.get(session.department);
      lastStatus.set(session.department, session.status);
      const stopped = session.status === 'off' || session.status === 'error';
      const wasRunning = was !== undefined && was !== 'off' && was !== 'error';
      if (stopped && wasRunning && Date.now() >= (restarting.get(session.department) ?? 0)) warned.delete(session.department);
    }
  });

  // The red line while approvals are off.
  const bypassLine = h(
    'div',
    { class: 'bypass-line', role: 'status', hidden: true },
    h('span', { class: 'bypass-dot', 'aria-hidden': 'true' }),
    h('span', { text: 'Approvals are off: the manager runs every tool without asking' }),
  );

  // Approvals.
  const approvals = h('div', { class: 'approvals', role: 'region', 'aria-label': 'Approvals', hidden: true });

  // The conversation.
  const emptyText = h('p', { class: 'messages-empty' });
  const list = h('div', { class: 'messages-list' });
  const scroller = h('div', { class: 'messages', role: 'log', 'aria-label': 'Conversation', tabindex: '0' }, emptyText, list);
  const scrollToEnd = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };
  scroller.addEventListener('scroll', () => {
    if (scroller.clientHeight > 0) pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX;
  });
  // An approval card, a longer roster or a resized sheet shrinks the log; keep the newest message in view.
  new ResizeObserver(() => {
    if (pinned) scrollToEnd();
  }).observe(scroller);
  // The approval card is pinned over the bottom of the conversation, so the list keeps room for it at its
  // end: padding as tall as the card, set again whenever the card grows or shrinks, and the newest message
  // scrolled back into view while the reader was at the bottom.
  new ResizeObserver(() => {
    const height = approvals.hidden ? 0 : Math.ceil(approvals.getBoundingClientRect().height);
    scroller.style.setProperty('--approvals-room', `${height}px`);
    if (pinned) scrollToEnd();
  }).observe(approvals);

  // What the manager is doing, and notices.
  const statusText = h('span');
  const status = h('div', { class: 'chat-status', hidden: true }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), statusText);
  const notice = h('p', { class: 'chat-notice', role: 'status', hidden: true });

  // The composer.
  const input = h('textarea', { class: 'composer-input', rows: '1', dir: 'auto', 'aria-label': 'Message to the manager' });
  const interrupt = h(
    'button',
    { class: 'btn btn--small btn--quiet', type: 'button', hidden: true, title: 'Stop the current turn' },
    icon('stop', 12),
    'Interrupt',
  );
  const sendButton = h('button', { class: 'send', type: 'submit', 'aria-label': 'Send', title: 'Send (Enter)' }, icon('send'));
  const composer = h(
    'form',
    { class: 'composer' },
    h(
      'div',
      { class: 'composer-box' },
      input,
      h(
        'div',
        { class: 'composer-row' },
        h('span', { class: 'composer-hint', text: 'Enter sends, Shift Enter adds a line' }),
        h('div', { class: 'composer-actions' }, interrupt, sendButton),
      ),
    ),
  );

  // The footer.
  const model = h('span', { class: 'foot-model' });
  const session = h('span', { class: 'foot-session' });
  const sessionButton = h('button', { class: 'btn btn--small btn--quiet', type: 'button' });
  const bypassSwitch = h(
    'button',
    { class: 'bypass-switch', type: 'button', role: 'switch', 'aria-checked': 'false' },
    h('span', { class: 'switch', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
    h('span', { class: 'bypass-label', text: 'Bypass approvals' }),
  );
  const keepAsking = h('button', { class: 'btn btn--small', type: 'button', text: 'Keep asking' });
  const turnOn = h('button', { class: 'btn btn--small btn--danger', type: 'button', text: 'Turn on bypass' });
  const bypassConfirm = h(
    'div',
    { class: 'bypass-confirm', role: 'alertdialog', 'aria-labelledby': 'bypass-confirm-title', hidden: true },
    h('p', { class: 'bypass-confirm-title', id: 'bypass-confirm-title', text: 'Turn off approvals for this manager?' }),
    h('p', {
      class: 'bypass-confirm-text',
      text: 'The manager and its subagents will run every tool, shell commands and file edits included, without asking you. This stays on until you turn it off or the session stops.',
    }),
    h('div', { class: 'bypass-confirm-actions' }, keepAsking, turnOn),
  );
  const footer = h(
    'footer',
    { class: 'chat-foot' },
    bypassConfirm,
    bypassSwitch,
    h('div', { class: 'foot-row' }, h('div', { class: 'foot-info' }, model, session), sessionButton),
  );

  const body = h('div', { class: 'chat-body' }, scroller, approvals);
  const el = h('section', { class: 'chat', 'aria-label': 'Manager chat' }, bypassLine, body, status, notice, composer, footer);

  function command(next: ClientCommand): boolean {
    if (!canSend(deps.store.getState())) {
      deps.toasts.show('The office is offline, so that did not go through.', 'error');
      return false;
    }
    deps.store.send(next);
    return true;
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_PX)}px`;
  }

  function submit() {
    if (!department) return;
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    if (!command({ type: 'chat.send', department: department.id, text })) return;
    input.value = '';
    deps.ui.drafts.delete(department.id);
    autosize();
    pinned = true;
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener('keydown', (event) => {
    // 229 is the keyCode of a key that an input method is still composing (Safari).
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    if (department) deps.ui.drafts.set(department.id, input.value);
    autosize();
  });
  interrupt.addEventListener('click', () => {
    if (department) command({ type: 'session.interrupt', department: department.id });
  });
  sessionButton.addEventListener('click', () => {
    if (!department) return;
    const on = isOn(sessionOf(deps.store.getState(), department.id));
    command({ type: on ? 'session.stop' : 'session.start', department: department.id });
  });

  // The bypass switch. Turning it on asks once per session; the warning says what it allows and until when.

  function showBypassConfirm(on: boolean) {
    bypassConfirm.hidden = !on;
    if (on) keepAsking.focus({ preventScroll: true });
  }

  function sendBypass(on: boolean) {
    if (!department) return;
    restarting.set(department.id, Date.now() + RESTART_MS);
    command({ type: 'session.bypass', department: department.id, on });
  }

  bypassSwitch.addEventListener('click', () => {
    if (!department) return;
    const state = deps.store.getState();
    if (isBusy(state, department.id)) {
      deps.toasts.show(BUSY_REASON);
      return;
    }
    if (sessionOf(state, department.id)?.bypass === true) sendBypass(false);
    else if (warned.has(department.id)) sendBypass(true);
    else showBypassConfirm(bypassConfirm.hidden);
  });
  keepAsking.addEventListener('click', () => {
    showBypassConfirm(false);
    bypassSwitch.focus();
  });
  turnOn.addEventListener('click', () => {
    if (!department) return;
    showBypassConfirm(false);
    warned.add(department.id);
    sendBypass(true);
    bypassSwitch.focus();
  });
  bypassConfirm.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    showBypassConfirm(false);
    bypassSwitch.focus();
  });

  // Approval cards.

  function answer(id: string, allow: boolean) {
    if (pending.has(id) || !command({ type: 'permission.answer', id, allow })) return;
    pending.set(
      id,
      window.setTimeout(() => {
        pending.delete(id);
        if (lastState && department) renderApprovals(lastState, department);
      }, PENDING_MS),
    );
    if (lastState && department) renderApprovals(lastState, department);
  }

  /**
   * One block of the request (the command, the old text of an edit, a URL) in a monospace block. All of
   * the text is there: a long one starts at a few lines, scrolls, and has a Show all button; a cut is said.
   */
  function createPart(part: PermissionPart): HTMLElement {
    const code = h('pre', { class: 'approval-code', dir: 'ltr', tabindex: '0', role: 'region', 'aria-label': part.label });
    code.textContent = part.text;
    const head = h('div', { class: 'approval-part-head' }, h('span', { class: 'approval-part-label', text: part.label }));
    const el = h('div', { class: 'approval-part' }, head, code);
    if (isLong(part.text)) {
      el.classList.add('is-long');
      const toggle = h('button', { class: 'approval-more', type: 'button', text: 'Show all', 'aria-expanded': 'false' });
      toggle.addEventListener('click', () => {
        const open = !el.classList.contains('is-open');
        el.classList.toggle('is-open', open);
        toggle.textContent = open ? 'Show less' : 'Show all';
        toggle.setAttribute('aria-expanded', String(open));
      });
      head.append(toggle);
    }
    if (part.cut > 0) el.append(h('p', { class: 'approval-cut', role: 'note', text: cutNote(part.cut) }));
    return el;
  }

  function createApproval(request: PermissionRequest): HTMLElement {
    const deny = h('button', { class: 'btn btn--small btn--quiet', type: 'button', text: 'Deny' });
    const allow = h('button', { class: 'btn btn--small btn--allow', type: 'button', text: 'Allow' });
    deny.addEventListener('click', () => answer(request.id, false));
    allow.addEventListener('click', () => answer(request.id, true));
    // Everything about the request never changes, so it is built once; only who asked and the pending look are updated.
    const meta = approvalMeta(request).map((line) =>
      h('p', { class: 'approval-meta' }, h('span', { class: 'approval-meta-label', text: line.label }), h('span', { class: 'approval-meta-text', dir: 'ltr', text: line.text })),
    );
    return h(
      'article',
      { class: 'approval' },
      h(
        'div',
        { class: 'approval-head' },
        h('span', { class: 'approval-tool', text: toolName(request.tool) }),
        h('span', { class: 'approval-who' }),
        h('time', { class: 'approval-time', text: clock(request.at), datetime: request.at }),
      ),
      h('p', { class: 'approval-summary', dir: 'auto', text: request.summary || toolName(request.tool) }),
      ...meta,
      ...approvalParts(request).map(createPart),
      h('div', { class: 'approval-foot' }, h('div', { class: 'approval-actions' }, deny, allow)),
    );
  }

  function fillApproval(card: HTMLElement, request: PermissionRequest, state: OfficeState) {
    const agent = request.agentId ? state.agents.find((a) => a.id === request.agentId) : null;
    const who = !agent || agent.kind === 'manager' ? 'the manager' : agent.cardKey ? `the ${agent.cardKey} agent` : 'a subagent';
    setText(card.querySelector('.approval-who')!, `asked by ${who}`);
    const waiting = pending.has(request.id);
    card.classList.toggle('is-pending', waiting);
    for (const button of card.querySelectorAll<HTMLButtonElement>('.approval-actions button')) button.disabled = waiting;
  }

  function renderApprovals(state: OfficeState, current: Department) {
    const requests = approvalsOf(state, current.id);
    approvals.hidden = requests.length === 0;
    syncList(approvals, requests, (r) => r.id, createApproval, (card, r) => fillApproval(card, r, state));
  }

  // Messages.

  function createMessage(message: ChatMessage): HTMLElement {
    return h(
      'div',
      { class: `msg msg--${message.role}` },
      h('div', { class: 'msg-meta' }, h('span', { class: 'msg-who' }), h('time', { class: 'msg-time' })),
      h('div', { class: 'msg-body', dir: 'auto' }),
    );
  }

  function fillMessage(el: HTMLElement, message: ChatMessage, index: number, messages: ChatMessage[], current: Department) {
    const previous = messages[index - 1];
    const grouped =
      !!previous &&
      previous.role === message.role &&
      previous.fromName === message.fromName &&
      Date.parse(message.at) - Date.parse(previous.at) < GROUP_GAP_MS;
    el.classList.toggle('is-grouped', grouped);
    el.classList.toggle('is-streaming', message.streaming);
    setAttr(el, 'aria-busy', message.streaming ? 'true' : null);
    setText(el.querySelector('.msg-who')!, speakerLabel(message, current));
    const time = el.querySelector('.msg-time') as HTMLTimeElement;
    setText(time, clock(message.at));
    setAttr(time, 'datetime', message.at);
    const body = el.querySelector('.msg-body') as HTMLElement;
    if (rendered.get(body) !== message.text) {
      renderText(body, message.text);
      rendered.set(body, message.text);
    }
  }

  function renderMessages(state: OfficeState, current: Department) {
    const messages = state.messages.filter((m) => m.department === current.id);
    syncList(list, messages, (m) => m.id, createMessage, (el, m, i) => fillMessage(el, m, i, messages, current));
    emptyText.hidden = messages.length > 0;
    if (!messages.length) {
      setText(
        emptyText,
        isOn(sessionOf(state, current.id))
          ? `No messages yet. Write to the ${managerTitle(current)} below.`
          : 'The manager is off. Start the session, or write below and it starts.',
      );
    }
    if (pinned) scrollToEnd();
  }

  function renderStatus(state: OfficeState, current: Department) {
    const manager = managerOf(state, current.id);
    const waiting = approvalsOf(state, current.id).length > 0;
    let text = '';
    if (isBusy(state, current.id) || waiting) {
      if (waiting || manager?.status === 'waiting') text = 'Waiting for your approval';
      else if (manager?.status === 'working') text = manager.currentTool ? `Running ${toolName(manager.currentTool)}` : 'Working';
      else if (manager?.status === 'thinking') text = 'Thinking';
      else text = 'Replying';
    }
    status.hidden = !text;
    status.dataset.tone = waiting ? 'warn' : '';
    setText(statusText, text);
  }

  function renderNotice(state: OfficeState, current: Department) {
    const sessionState = sessionOf(state, current.id);
    let text = '';
    let tone = '';
    if (sessionState?.status === 'error') {
      text = `The session stopped: ${sessionState.error ?? 'no reason given'}. Start it again to continue.`;
      tone = 'error';
    } else if (!canSend(state)) {
      text = 'The office is offline. Your draft stays here until it reconnects.';
    }
    notice.hidden = !text;
    notice.dataset.tone = tone;
    setText(notice, text);
  }

  function renderFooter(state: OfficeState, current: Department) {
    const sessionState = sessionOf(state, current.id);
    setText(model, modelName(sessionState?.model ?? current.model));
    const id = sessionState?.sessionId ?? current.sessionId;
    setText(session, id ? `Session ${id.slice(0, 8)}` : 'No session yet');
    setAttr(session, 'title', id ? `Session id ${id}` : null);
    const on = isOn(sessionState);
    setText(sessionButton, on ? 'Stop session' : 'Start session');
    interrupt.hidden = !isBusy(state, current.id);

    // Bypass: the red line, the switch, and the reason when the switch cannot be used.
    const bypass = sessionState?.bypass === true;
    const busy = isBusy(state, current.id);
    el.classList.toggle('is-bypass', bypass);
    bypassLine.hidden = !bypass;
    setAttr(bypassSwitch, 'aria-checked', String(bypass));
    setAttr(bypassSwitch, 'aria-disabled', busy ? 'true' : null);
    setAttr(
      bypassSwitch,
      'title',
      busy ? BUSY_REASON : bypass ? 'Stop bypassing: the manager asks again, as its policy says.' : 'Let the manager run every tool without asking.',
    );
    if (bypass) showBypassConfirm(false);
  }

  return {
    el,
    update(state, current) {
      if (department?.id !== current.id) {
        input.value = deps.ui.drafts.get(current.id) ?? '';
        autosize();
        pinned = true;
        showBypassConfirm(false);
      }
      department = current;
      setAttr(input, 'placeholder', `Message the ${managerTitle(current)}`);
      if (state === lastState) return;
      lastState = state;
      renderApprovals(state, current);
      renderMessages(state, current);
      renderStatus(state, current);
      renderNotice(state, current);
      renderFooter(state, current);
      if (pinned) scrollToEnd();
    },
    scrollToEnd() {
      pinned = true;
      scrollToEnd();
    },
    focus() {
      input.focus();
    },
  };
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

/** Plain text with three bits of Markdown the manager uses most: fenced code, `code` and **bold**. */
function renderText(target: HTMLElement, text: string): void {
  target.textContent = '';
  const parts = text.split('```');
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const code = part.replace(/^[\w+.#]*\n/, '').replace(/\n$/, '');
      target.append(h('pre', { class: 'msg-code', dir: 'ltr' }, h('code', { text: code })));
      return;
    }
    let chunk = part;
    if (i > 0) chunk = chunk.replace(/^\n/, '');
    if (i < parts.length - 1) chunk = chunk.replace(/\n$/, '');
    appendInline(target, chunk);
  });
}

function appendInline(target: HTMLElement, text: string): void {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) target.append(text.slice(last, index));
    const token = match[0];
    target.append(token.startsWith('`') ? h('code', { text: token.slice(1, -1) }) : h('strong', { text: token.slice(2, -2) }));
    last = index + token.length;
  }
  if (last < text.length) target.append(text.slice(last));
}
