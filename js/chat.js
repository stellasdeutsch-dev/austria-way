/**
 * Чат-помощник: панель, история, карточки предложений.
 *
 * Ответы собирает assistant.js по данным плана, без языковой модели. Здесь
 * только интерфейс: панель открывается кнопкой и не занимает треть экрана,
 * когда ею не пользуются.
 */

import { $, $$, esc, formatDate } from './utils.js';
import { applyOperations } from './plan.js';
import { heuristicReply } from './assistant.js';
import { markDeadlineEdit } from './steps.js';

let ctx = null; // { state, persist, rerender }

/* ------------------------------------------------------------------ */
/* Панель                                                              */
/* ------------------------------------------------------------------ */

let returnFocus = null;

export function openChat() {
  const drawer = $('#chatDrawer');
  if (!drawer || !drawer.hidden) return;
  returnFocus = document.activeElement;
  drawer.hidden = false;
  $('#chatToggle')?.setAttribute('aria-expanded', 'true');
  document.body.classList.add('chat-open');
  $('#chatInput')?.focus();
  const log = $('#chatLog');
  log.scrollTop = log.scrollHeight;
}

export function closeChat() {
  const drawer = $('#chatDrawer');
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  $('#chatToggle')?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('chat-open');
  (returnFocus && document.contains(returnFocus) ? returnFocus : $('#chatToggle'))?.focus();
}

/* ------------------------------------------------------------------ */
/* История                                                             */
/* ------------------------------------------------------------------ */

const EMPTY_HINT =
  'Спросите про шаг, срок или документы: «что дальше?», «когда виза?», «что ты умеешь?». ' +
  'Ответы собираются из вашего плана по заданным правилам — это не языковая модель.';

export function renderChatHistory() {
  const { state } = ctx;
  const log = $('#chatLog');
  log.innerHTML = '';

  if (!state.messages.length) {
    const p = document.createElement('p');
    p.className = 'msg msg-empty';
    p.textContent = EMPTY_HINT;
    log.append(p);
    $('#chatSuggestions').hidden = false;
  } else {
    for (const m of state.messages) {
      if (m.system) appendSystem(m.content);
      else appendMessage(m.role, m.content);
    }
    $('#chatSuggestions').hidden = true;
  }

  if (state.pendingProposal) appendProposal(state.pendingProposal);
  log.scrollTop = log.scrollHeight;
}

function appendMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg msg-${role === 'user' ? 'user' : 'ai'}`;
  el.textContent = text;
  $('#chatLog').append(el);
  return el;
}

function appendSystem(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-system';
  el.textContent = text;
  $('#chatLog').append(el);
}

/**
 * Карточка предложения замыкается на конкретный объект proposal, а не
 * читает состояние заново при клике — иначе клик по устаревшей карточке
 * падает, если pendingProposal к этому моменту уже другой. Живой может быть
 * только одна карточка; предыдущая незакрытая явно помечается устаревшей.
 */
function appendProposal(proposal) {
  const stale = $('#chatLog .proposal:not(.is-stale)');
  if (stale) markProposalStale(stale);

  const el = document.createElement('div');
  el.className = 'proposal';
  el.dataset.proposalId = proposal.id;
  el.innerHTML = `
    <h3>Предлагаю обновить план</h3>
    <p>${esc(proposal.rationale)}</p>
    <ul>${proposal.operations.map((op) => `<li>${esc(describeOp(op))}</li>`).join('')}</ul>
    <div class="proposal-actions">
      <button class="btn btn-primary btn-sm" data-apply type="button">Применить</button>
      <button class="btn btn-ghost btn-sm" data-dismiss type="button">Не нужно</button>
    </div>`;

  el.querySelector('[data-apply]').addEventListener('click', () => applyProposal(el, proposal));
  el.querySelector('[data-dismiss]').addEventListener('click', () => dismissProposal(el, proposal));

  $('#chatLog').append(el);
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function markProposalStale(el) {
  el.classList.add('is-stale');
  el.querySelectorAll('button').forEach((b) => (b.disabled = true));
  if (!el.querySelector('.proposal-stale-note')) {
    const p = document.createElement('p');
    p.className = 'proposal-stale-note';
    p.textContent = 'Это предложение устарело — разговор продолжился дальше.';
    el.append(p);
  }
}

function describeOp(op) {
  const step = ctx.state.roadmap?.steps.find((s) => s.id === op.stepId);
  const name = op.title || step?.title || op.stepId;
  if (op.op === 'add_step') return `Добавить шаг «${name}»`;
  if (op.op === 'remove_step') return `Убрать шаг «${name}»`;
  const changes = [];
  if (op.deadline) changes.push(`срок → ${formatDate(op.deadline)}`);
  if (op.description) changes.push('описание');
  return `Обновить «${name}»${changes.length ? `: ${changes.join(', ')}` : ''}`;
}

function applyProposal(card, proposal) {
  const { state, persist, rerender } = ctx;
  if (card.classList.contains('is-stale')) return;
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));

  const { roadmap, applied } = applyOperations(state.roadmap, proposal.operations);
  // Срок, перенесённый по просьбе человека, — его решение: «Изменить ответы»
  // не должно пересчитать его обратно.
  for (const op of proposal.operations) {
    if (op.op === 'update_step' && op.deadline) markDeadlineEdit(roadmap.steps.find((s) => s.id === op.stepId));
  }
  state.roadmap = roadmap;
  if (state.pendingProposal?.id === proposal.id) state.pendingProposal = null;

  card.remove();
  const systemText = applied.length ? `План обновлён: ${applied.join(', ')}` : 'Изменений не потребовалось';
  appendSystem(systemText);
  state.messages.push({ role: 'assistant', content: systemText, system: true });
  persist();
  rerender();
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}

function dismissProposal(card, proposal) {
  const { state, persist } = ctx;
  if (state.pendingProposal?.id === proposal.id) state.pendingProposal = null;
  persist();
  card.remove();
}

/* ------------------------------------------------------------------ */
/* Отправка                                                            */
/* ------------------------------------------------------------------ */

function sendMessage(message) {
  const { state, persist } = ctx;
  state.streaming = true;
  $('#chatSend').disabled = true;

  const log = $('#chatLog');
  const bubble = appendMessage('assistant', '');
  bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  log.scrollTop = log.scrollHeight;

  const { text, proposal } = heuristicReply(message, {
    profileName: state.profile?.name,
    steps: state.roadmap?.steps ?? [],
    roadmap: state.roadmap,
    profile: state.profile,
  });

  // Ответ появляется кусками — только ради ощущения разговора; он уже готов.
  setTimeout(() => {
    bubble.textContent = '';
    let shown = '';
    const chunks = text.match(/.{1,24}/gs) ?? [];
    let i = 0;
    const tick = () => {
      if (i >= chunks.length) {
        state.messages.push({ role: 'assistant', content: text, ...(proposal ? { proposal } : {}) });
        if (proposal) {
          state.pendingProposal = proposal;
          appendProposal(proposal);
        }
        persist();
        state.streaming = false;
        $('#chatSend').disabled = false;
        log.scrollTop = log.scrollHeight;
        return;
      }
      shown += chunks[i++];
      bubble.textContent = shown;
      log.scrollTop = log.scrollHeight;
      setTimeout(tick, 14);
    };
    tick();
  }, 250);
}

export function initChat({ state, persist, rerender }) {
  ctx = { state, persist, rerender };
  const form = $('#chatForm');
  const input = $('#chatInput');

  $('#chatToggle')?.addEventListener('click', () => ($('#chatDrawer').hidden ? openChat() : closeChat()));
  $('#chatClose')?.addEventListener('click', closeChat);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#chatDrawer')?.hidden) closeChat();
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  $$('#chatSuggestions .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      input.value = chip.textContent.trim();
      form.requestSubmit();
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message || state.streaming) return;

    input.value = '';
    input.style.height = 'auto';
    $('#chatSuggestions').hidden = true;

    $('#chatLog').querySelector('.msg-empty')?.remove();
    appendMessage('user', message);
    state.messages.push({ role: 'user', content: message });
    persist();

    sendMessage(message);
  });
}
