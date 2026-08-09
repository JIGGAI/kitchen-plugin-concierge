import { api, formatDate, t } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  const MODELS = ['gpt-5.5', 'gpt-5', 'gpt-5-mini'];

  type Config = { persona: string; model: string; enabledSlices: string[] | null };
  type ConversationRow = {
    id: string;
    userId: string;
    status: string;
    summary: string | null;
    createdAt: string;
    lastActiveAt: string;
    messageCount: number;
  };

  function Concierge({ teamId }: { teamId: string }) {
    const [cfg, setCfg] = useState(null as Config | null);
    const [rows, setRows] = useState(null as ConversationRow[] | null);
    const [note, setNote] = useState(null as string | null);
    const [busy, setBusy] = useState(null as string | null);

    const loadConfig = () =>
      api('concierge', teamId, '/config')
        .then(setCfg)
        .catch((e: Error) => setNote(`Could not load configuration: ${e.message}`));

    const loadRows = () =>
      api('concierge', teamId, '/conversations')
        .then((d: any) => setRows(d.conversations ?? []))
        .catch(() => setRows([]));

    useEffect(() => { loadConfig(); loadRows(); }, [teamId]);

    async function save(patch: Partial<Config>) {
      setBusy('config');
      setNote(null);
      try {
        const next = await api('concierge', teamId, '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        setCfg(next);
        setNote('Saved.');
      } catch (e: any) {
        setNote(e.message || 'Save failed.');
      } finally {
        setBusy(null);
      }
    }

    async function remove(row: ConversationRow) {
      const ok = window.confirm(
        `Permanently delete this conversation?\n\n`
        + `${row.messageCount} message(s) from ${row.userId}, last active ${formatDate(row.lastActiveAt)}.\n\n`
        + `This cannot be undone.`,
      );
      if (!ok) return;
      setBusy(row.id);
      try {
        await api('concierge', teamId, `/conversations/${row.id}`, { method: 'DELETE' });
        await loadRows();
      } catch (e: any) {
        setNote(e.message || 'Delete failed.');
      } finally {
        setBusy(null);
      }
    }

    if (!cfg) return h('div', { style: t.page }, note ?? 'Loading…');

    const totalMessages = (rows ?? []).reduce((n: number, r: ConversationRow) => n + r.messageCount, 0);

    return h('div', { style: t.page },
      h('h2', { style: t.h2 }, 'Concierge'),
      h('p', { style: t.muted },
        'Persona and model for the dashboard chat box. Which data the concierge can '
        + 'read is defined in the slice registry and changed by a commit, not here.'),

      h('label', { style: t.label }, 'Persona',
        h('textarea', {
          value: cfg.persona,
          rows: 6,
          style: t.input,
          onChange: (e: any) => setCfg({ ...cfg, persona: e.target.value }),
        })),

      h('label', { style: t.label }, 'Model',
        h('select', {
          value: cfg.model,
          style: { display: 'block', marginTop: 6 },
          onChange: (e: any) => save({ model: e.target.value }),
        }, MODELS.map((m) => h('option', { key: m, value: m }, m)))),

      h('button', {
        style: { marginTop: 20 },
        disabled: busy === 'config',
        onClick: () => save({ persona: cfg.persona }),
      }, busy === 'config' ? 'Saving…' : 'Save persona'),

      note ? h('p', { style: { marginTop: 12 } }, note) : null,

      h('section', { style: t.section },
        h('h3', null, 'Conversations'),
        h('p', { style: t.muted },
          rows === null
            ? 'Loading…'
            : `${rows.length} conversation(s), ${totalMessages} message(s). Nothing is deleted `
              + 'automatically — idle threads are summarized and kept. Delete here to remove one permanently.'),

        rows === null ? null : h('table', { style: t.table },
          h('thead', null,
            h('tr', null,
              h('th', { style: t.th }, 'User'),
              h('th', { style: t.th }, 'Status'),
              h('th', { style: t.th }, 'Msgs'),
              h('th', { style: t.th }, 'Last active'),
              h('th', { style: t.th }, 'Summary'),
              h('th', { style: t.th }, ''))),
          h('tbody', null,
            rows.length === 0
              ? h('tr', null, h('td', { style: { ...t.td, ...t.faint }, colSpan: 6 }, 'No conversations yet.'))
              : rows.map((r: ConversationRow) => h('tr', { key: r.id },
                h('td', { style: t.td }, r.userId),
                h('td', { style: t.td }, r.status),
                h('td', { style: t.td }, String(r.messageCount)),
                h('td', { style: t.td }, formatDate(r.lastActiveAt)),
                h('td', { style: { ...t.td, ...t.faint } },
                  r.summary ? r.summary.slice(0, 90) + (r.summary.length > 90 ? '…' : '') : '—'),
                h('td', { style: { ...t.td, textAlign: 'right' } },
                  h('button', {
                    disabled: busy === r.id,
                    onClick: () => remove(r),
                  }, busy === r.id ? 'Deleting…' : 'Delete'))))))),
    );
  }

  (window as any).KitchenPlugin.registerTab('concierge', 'concierge', Concierge);
})();
