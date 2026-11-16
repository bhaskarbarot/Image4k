/* SQL Formatter — sql-formatter 15.8.2 (MIT, self-hosted, lazy-loaded). SQL is formatted only, never executed. */
import { h, editor, output, msgBox, seg, select, field, checkbox, primary, btn, toolbar, grid2, store, loadScript, toast } from '../ui.js';
import { minifySql } from '../lib/sqlmin.js';

const LIB = '/assets/vendor/sql-formatter-15.8.2/sql-formatter.min.js';
const DIALECTS = [
  ['sql', 'Standard SQL'], ['postgresql', 'PostgreSQL'], ['mysql', 'MySQL'], ['mariadb', 'MariaDB'], ['sqlite', 'SQLite'],
  ['transactsql', 'SQL Server (T-SQL)'], ['plsql', 'Oracle PL/SQL'], ['bigquery', 'BigQuery'], ['snowflake', 'Snowflake'],
  ['redshift', 'Amazon Redshift'], ['db2', 'IBM Db2'], ['hive', 'Apache Hive'], ['spark', 'Spark SQL'], ['trino', 'Trino / Presto'],
  ['duckdb', 'DuckDB'], ['clickhouse', 'ClickHouse'], ['n1ql', 'Couchbase N1QL'], ['singlestoredb', 'SingleStore'], ['tidb', 'TiDB'],
];
const SAMPLE = `select u.id, u.email, count(o.id) as orders, sum(o.total) as revenue from users u left join orders o on o.user_id = u.id and o.status in ('paid','shipped') where u.created_at >= '2026-01-01' and u.email not like '%@test.%' group by u.id, u.email having count(o.id) > 2 order by revenue desc limit 50;
update users set last_seen = now() where id = 42;`;

export function mount(root) {
  const s = store.get('sql-formatter', { dialect: 'postgresql', kw: 'upper', indent: '2', lines: '1', keepComments: false });
  const save = () => store.set('sql-formatter', s);
  const msg = msgBox();
  const input = editor({ label: 'Input SQL', placeholder: 'Paste one or more SQL statements', sample: SAMPLE, paste: true, clear: true, file: { accept: '.sql,text/plain' } });
  const out = output({ label: 'Result', download: { name: 'formatted.sql', mime: 'application/sql' }, empty: 'Formatted SQL will appear here.' });
  const dialect = select(DIALECTS, s.dialect, (v) => { s.dialect = v; save(); rerun(); });
  const kw = seg([['preserve', 'Keep'], ['upper', 'UPPER'], ['lower', 'lower']], s.kw, (v) => { s.kw = v; save(); rerun(); }, 'Keyword case');
  const indent = seg([['2', '2'], ['4', '4'], ['tab', 'Tab']], s.indent, (v) => { s.indent = v; save(); rerun(); }, 'Indentation');
  const lines = select([['0', '0'], ['1', '1'], ['2', '2']], s.lines, (v) => { s.lines = v; save(); rerun(); });
  const keep = checkbox('Keep comments when minifying', s.keepComments, (v) => { s.keepComments = v; save(); });
  let lastMode = null;
  const rerun = () => { if (lastMode === 'format' && out.get()) run('format'); };

  async function run(mode) {
    const src = input.get();
    msg.hide();
    if (!src.trim()) { out.set(''); msg.error('Nothing to format — paste some SQL first.'); return; }
    try {
      if (mode === 'minify') {
        const m = minifySql(src, { dialect: s.dialect, keepComments: s.keepComments });
        out.set(m); lastMode = mode;
        toast(`Minified: ${src.length.toLocaleString()} → ${m.length.toLocaleString()} characters`);
        return;
      }
      const lib = await loadScript(LIB, 'sqlFormatter');
      const formatted = lib.format(src, {
        language: s.dialect,
        keywordCase: s.kw,
        tabWidth: s.indent === 'tab' ? 2 : Number(s.indent),
        useTabs: s.indent === 'tab',
        linesBetweenQueries: Number(s.lines),
      });
      out.set(formatted); lastMode = mode;
    } catch (e) {
      out.set('');
      const text = String(e && e.message || e);
      const first = text.split('\n')[0];
      const loc = /line (\d+) column (\d+)/i.exec(first);
      if (e.name === 'SqlError') msg.error('Could not minify — ' + e.reason, `Line ${e.line}`);
      else if (/Parse error/i.test(first)) msg.error('The SQL could not be parsed for the ' + DIALECTS.find((d) => d[0] === s.dialect)[1] + ' dialect', first.replace(/^Parse error:?\s*/i, '') + (loc ? '' : '') + '\nTip: check for a typo near that position, or pick the matching dialect (e.g. MySQL for backtick `identifiers`).');
      else msg.error('Could not format the SQL', first);
    }
  }
  input.ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run('format'); } });
  root.append(
    toolbar(primary('Format', () => run('format'), { 'data-act': 'format' }), btn('Minify', () => run('minify'), undefined, { 'data-act': 'minify' })),
    h('div', { class: 'dt-row' }, field('Dialect', dialect), field('Keywords', kw), field('Indent', indent), field('Blank lines between queries', lines), keep),
    msg.el,
    grid2(input.el, out.el),
    h('p', { class: 'dt-msg is-info sq-safe' }, h('strong', null, 'SQL is formatted only — never executed.'), ' Nothing is sent to a database or a server; all processing happens in your browser. Minify keeps strings, quoted identifiers, dollar-quoted bodies and optimizer hints (/*+ … */) exactly; other comments are removed unless you keep them (line comments then become /* … */).'),
  );
}
