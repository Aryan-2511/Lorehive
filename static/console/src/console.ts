import { invoke } from '@forge/bridge';

/* eslint-disable @typescript-eslint/no-explicit-any */
type State = any;

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
// Evidence text comes from tickets and commits: always escape.
const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const link = (url: string, text = 'link') => (/^https:\/\//.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));
const seededTag = (s: boolean) => (s ? ' <span class="badge seeded">seeded</span>' : '');
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

let state: State;

async function refresh() {
  state = await invoke('getState');
  render();
}

function render() {
  const s = state;
  $('#demo-badge').classList.toggle('hidden', !s.demo);
  const lb = $('#ledger-badge');
  lb.textContent = s.ledgerOk ? `Ledger verified (${s.ledger.length} entries)` : 'Ledger chain broken';
  lb.className = `badge ${s.ledgerOk ? 'ok' : 'bad'}`;
  $('#first-run').classList.toggle('hidden', s.lessons.length > 0 || s.evidence.length > 0);
  renderFleet(s);
  renderLessons(s);
  renderFeed(s);
  renderDelivery(s);
  renderDemo(s);
}

function renderFleet(s: State) {
  const count = (st: string) => s.lessons.filter((l: any) => l.status === st).length;
  const rejected = s.evidence.filter((e: any) => e.kind === 'text_claim').length;
  $('[data-panel=fleet]').innerHTML = `
    <div class="grid">
      <div class="card"><div class="stat">${s.fleet.agents.length}</div><div class="muted">agents</div></div>
      <div class="card"><div class="stat">${s.fleet.repos.length}</div><div class="muted">repos</div></div>
      <div class="card"><div class="stat">${s.fleet.projects.length}</div><div class="muted">Jira projects</div></div>
      <div class="card"><div class="stat">${count('promoted')}</div><div class="muted">promoted lessons · ${count('candidate')} candidates</div></div>
      <div class="card"><div class="stat">${rejected}</div><div class="muted">text claims recorded, never counted</div></div>
    </div>
    <div class="card"><h2>Fleet</h2><ul class="plain">
      ${s.fleet.agents.map((a: any) => `<li><b>${esc(a.label)}</b> <span class="muted">${esc(a.id)}</span><br><span class="muted">${esc([...a.repos, ...a.projects].join(' · ') || '—')}</span></li>`).join('') || '<li class="muted">No agents yet. Start the demo, or connect GitHub and Bitbucket.</li>'}
    </ul></div>`;
}

function renderLessons(s: State) {
  const order = ['promoted', 'candidate', 'superseded', 'retired', 'vetoed'];
  const lessons = [...s.lessons].sort((a: any, b: any) => order.indexOf(a.status) - order.indexOf(b.status));
  $('[data-panel=lessons]').innerHTML =
    lessons
      .map(
        (l: any) => `
    <div class="card">
      <div class="row"><span class="status ${esc(l.status)}">${esc(l.status)}</span><h3>${esc(l.title)}</h3>${seededTag(l.seeded)}<span class="muted">${esc(l.id)}</span></div>
      <p>${esc(l.rule)}</p>
      <p class="muted">Quorum: ${l.quorum.people} people, ${l.quorum.places} places${l.quorum.missing.length ? ` · ${esc(l.quorum.missing.join('; '))}` : ''}</p>
      <p class="muted">Valid from ${esc(l.validFrom ?? '—')}${l.validTo ? ` to ${esc(l.validTo)}` : ''}${l.supersededBy ? ` · superseded by ${esc(l.supersededBy)}` : ''}${l.retiredReason ? ` · ${esc(l.retiredReason)}` : ''}</p>
      ${l.efficacy ? efficacy(l.efficacy) : ''}
      <details><summary>Evidence (${l.verdicts.length})</summary><ul class="plain">
        ${l.verdicts.map((v: any) => {
          const e = s.evidence.find((x: any) => x.id === v.evidenceId);
          return `<li><span class="${v.counted ? 'counted' : 'rejected'}">${v.counted ? '✓' : '✗'} ${esc(v.label)}</span> — ${esc(e?.summary ?? v.evidenceId)} ${e ? link(e.url, e.scope.repo ?? e.scope.project ?? 'link') : ''}</li>`;
        }).join('')}
      </ul></details>
      ${l.vetoProposal ? `<p class="rejected">Veto proposed: ${esc(l.vetoProposal.reason)}</p>` : ''}
      ${l.status === 'promoted' ? `<button class="secondary" data-veto="${esc(l.id)}">Veto</button>` : ''}
    </div>`,
      )
      .join('') || '<div class="card muted">No lessons yet.</div>';
}

function efficacy(e: any) {
  const max = Math.max(e.canaryRate, e.holdoutRate, 0.01);
  const h = (x: number) => Math.max(4, Math.round((x / max) * 80));
  return `<div class="card"><div class="row"><b>Efficacy</b><span class="badge seeded">seeded history</span><span class="muted">verdict: ${esc(e.verdict)}, change ${e.lift > 0 ? '+' : ''}${pct(e.lift)}</span></div>
    <div class="bars"><div style="height:${h(e.canaryRate)}px" title="canary"></div><div class="holdout" style="height:${h(e.holdoutRate)}px" title="holdout"></div></div>
    <p class="muted">Recurrence per agent PR: canary ${pct(e.canaryRate)} (${e.canaryPrs} PRs) vs holdout ${pct(e.holdoutRate)} (${e.holdoutPrs} PRs)</p></div>`;
}

function renderFeed(s: State) {
  $('[data-panel=feed]').innerHTML = `<div class="card"><h2>Ledger</h2><ul class="plain">
    ${s.ledger.map((e: any) => `<li><b>${esc(e.type)}</b> <span class="muted">#${e.seq} · ${esc(e.at)}</span> ${esc(e.subject)}${seededTag(!!e.payload?.seeded)}<br><span class="muted">${esc(feedLine(e))}</span></li>`).join('') || '<li class="muted">Nothing yet.</li>'}
  </ul></div>`;
}

function feedLine(e: any) {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'evidence.recorded': return `${p.kind} by ${p.actor} in ${p.scope ?? '?'} (topic ${p.topic ?? '—'})`;
    case 'lesson.promoted': return `${p.title}: ${p.actors?.length} people, ${p.scopes?.length} places`;
    case 'lesson.rejected': return `candidate: ${(p.missing ?? []).join('; ')}`;
    case 'lesson.propagated': return `rev ${p.rev}: ${(p.files ?? []).map((f: any) => `${f.path} ${f.bytes}/${f.budget}B`).join(', ')}`;
    default: return JSON.stringify(p).slice(0, 160);
  }
}

function renderDelivery(s: State) {
  $('[data-panel=delivery]').innerHTML = `<div class="card"><h2>Instruction files and size budget</h2><ul class="plain">
    ${s.budgets.map((b: any) => `<li><div class="row"><b>${esc(b.path)}</b><span class="muted">${b.bytes}/${b.budget} bytes · ${b.included} lessons${b.omitted ? `, ${b.omitted} via lessons_for` : ''}</span></div>
      <div class="meter"><span style="width:${Math.min(100, (b.bytes / b.budget) * 100)}%"></span></div></li>`).join('')}
  </ul><p><button class="secondary" id="preview">Preview AGENTS.md block</button></p><pre id="preview-out" class="hidden"></pre></div>
  <div class="card"><h2>Connected repos</h2>
    ${s.webhookUrl ? `<p class="muted">GitHub webhook URL. Keep it private.</p><pre>${esc(s.webhookUrl)}</pre>` : ''}
    <ul class="plain">
    ${s.connected.map((r: any, i: number) => `<li><div class="row"><b>${esc(r.repo)}</b>
      <label><input type="checkbox" id="auto-${i}" ${r.autoPr ? 'checked' : ''}> Open lesson PRs</label>
      <label>Jira project <input type="text" size="8" id="proj-${i}" value="${esc(r.project ?? '')}"></label>
      <button class="secondary" data-repo-save="${i}">Save</button></div></li>`).join('') || '<li class="muted">No repos yet. A repo appears here when its first webhook arrives. It gets no PRs until you turn them on.</li>'}
    </ul><p class="muted">Lessons from a repo with no Jira project are visible to everyone on this site.</p></div>
  <div class="card"><h2>MCP</h2><p>Outside agents (Claude Code, Cursor) call <code>lessons_for</code> and <code>report_outcome</code> through the Lorehive Rovo MCP server. Rovo Studio agents add the same tools.</p></div>`;
}

function renderDemo(s: State) {
  $('[data-panel=demo]').innerHTML = `<div class="card"><h2>Demo story</h2><p class="muted">Every item below is seeded and labelled as such.</p>
    <div class="row"><button class="primary" id="full-demo">Run whole story</button><button class="secondary" id="measure">Measure efficacy</button><button class="secondary" id="reset">Reset</button></div></div>
    ${s.steps.map((st: any, i: number) => `<div class="card"><div class="row"><b>${i + 1}. ${esc(st.title)}</b></div><p class="muted">${esc(st.narration)}</p><button class="secondary" data-step="${esc(st.id)}">Play</button> <span id="out-${esc(st.id)}" class="muted"></span></div>`).join('')}`;
}

function notice(message: string) {
  const el = $('#notice');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

async function busy<T>(btn: HTMLButtonElement | null, fn: () => Promise<T>) {
  if (btn) btn.disabled = true;
  notice('');
  try {
    const result = await fn();
    if ((result as any)?.ok === false) notice((result as any).message);
    return result;
  } catch (err) {
    console.error(err);
    notice('That action failed. Check the app logs for details.');
    return undefined as T;
  } finally {
    if (btn) btn.disabled = false;
    await refresh();
  }
}

document.addEventListener('click', async (ev) => {
  const t = ev.target as HTMLElement;
  const btn = t.closest('button') as HTMLButtonElement | null;
  if (!btn) return;
  if (btn.dataset.tab) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', (p as HTMLElement).dataset.panel !== btn.dataset.tab));
    return;
  }
  if (btn.id === 'start-demo') {
    await busy(btn, () => invoke('runDemoStep', { stepId: 'history' }));
    (document.querySelector('[data-tab=demo]') as HTMLButtonElement).click();
  }
  if (btn.id === 'full-demo') await busy(btn, () => invoke('runFullDemo'));
  if (btn.id === 'measure') await busy(btn, () => invoke('measureNow'));
  if (btn.id === 'reset') {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Click again to delete all demo data';
      return;
    }
    await busy(btn, () => invoke('resetDemo'));
  }
  if (btn.dataset.step) {
    const id = btn.dataset.step;
    const r: any = await busy(btn, () => invoke('runDemoStep', { stepId: id }));
    const out = document.getElementById(`out-${id}`);
    if (out && r) out.textContent = r.results.map((x: any) => (x.promoted ? 'promoted' : x.kind === 'text_claim' ? 'recorded as text, not evidence' : x.missing.join('; ') || 'recorded')).join(' · ');
  }
  if (btn.dataset.veto) {
    const id = btn.dataset.veto;
    btn.insertAdjacentHTML('afterend', `<div class="row"><input type="text" size="40" placeholder="Why veto this lesson?" data-veto-reason="${esc(id)}"><button class="primary" data-veto-confirm="${esc(id)}">Confirm veto</button></div>`);
    btn.remove();
  }
  if (btn.dataset.vetoConfirm) {
    const id = btn.dataset.vetoConfirm;
    const reason = (document.querySelector(`[data-veto-reason="${CSS.escape(id)}"]`) as HTMLInputElement).value.trim();
    if (!reason) return notice('Enter a reason for the veto.');
    await busy(btn, () => invoke('veto', { lessonId: id, reason }));
  }
  if (btn.dataset.repoSave !== undefined) {
    const i = btn.dataset.repoSave;
    await busy(btn, () =>
      invoke('updateRepo', {
        repo: state.connected[Number(i)].repo,
        autoPr: (document.getElementById(`auto-${i}`) as HTMLInputElement).checked,
        project: (document.getElementById(`proj-${i}`) as HTMLInputElement).value,
      }),
    );
  }
  if (btn.id === 'preview') {
    const c: any = await invoke('previewFile', { format: 'agents-md' });
    const pre = $('#preview-out');
    pre.textContent = c.block;
    pre.classList.remove('hidden');
  }
});

refresh();
