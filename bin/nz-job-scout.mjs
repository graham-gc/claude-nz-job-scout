#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readJson } from '../src/store.mjs';
import { start, inRun, discover, index, details, associate, inventory, ticket, searchResult } from '../src/engine.mjs';
import { produce } from '../src/report.mjs';

const help = `NZ Job Scout v1 (development)
All commands run in the target project, not the plugin cache. JSON output only.
  start --input request.json --resume /absolute/resume.pdf
  discover --run RUN_ID
  index --run RUN_ID [--offset 100]
  search-ticket --run RUN_ID
  search-result --run RUN_ID --ticket N [--url HTTPS_URL ... | --error MESSAGE]
  details --run RUN_ID --record RECORD_ID [--record RECORD_ID ...]
  record --run RUN_ID --record RECORD_ID
  associate --run RUN_ID --record RECORD_ID --official HTTPS_CAREERS_URL
  inventory --run RUN_ID --record RECORD_ID --official HTTPS_CAREERS_URL
  report --run RUN_ID --judgments judgments.json
Optional --project /absolute/project on every command. No cleanup, login, shell-fetch,
plugin installation, application submission or source-editing subcommands.`;
try {
  const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string' }, input: { type: 'string' }, resume: { type: 'string' }, run: { type: 'string' },
    ticket: { type: 'string' }, url: { type: 'string', multiple: true }, error: { type: 'string' },
    record: { type: 'string', multiple: true }, official: { type: 'string' }, judgments: { type: 'string' },
    offset: { type: 'string' }, help: { type: 'boolean' },
  } });
  const command = positionals[0], project = a.project ?? process.cwd();
  if (a.help || !command) { process.stdout.write(help + '\n'); process.exit(0); }
  const required = (...names) => { for (const name of names) if (!a[name]) throw new Error(`Missing --${name}; use --help`); };
  let result;
  if (command === 'start') { required('input', 'resume'); result = await start(project, await readJson(a.input), a.resume); }
  else {
    required('run');
    result = await inRun(project, a.run, async (state, reader, root) => {
      switch (command) {
        case 'discover': return discover(state, reader);
        case 'index': {
          const result = index(state), offset = Number(a.offset ?? 0);
          if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
          // Paginate the compact index without dumping the full evidence store.
          const all = [...state.records];
          if (offset) {
            const { relevant } = await import('../src/engine.mjs');
            result.records = all.filter(r => relevant(r, state.config)).slice(offset, offset + 100).map(r => ({ recordId: r.recordId, title: r.fields.title?.value ?? r.lead.title, employer: r.fields.employer?.value ?? r.lead.employer, location: r.fields.location?.value, readState: r.readState, url: r.canonicalUrl }));
          }
          return result;
        }
        case 'search-ticket': return ticket(state);
        case 'search-result': required('ticket'); return searchResult(state, a.ticket, a.url ?? [], a.error);
        case 'details': required('record'); return details(state, reader, a.record);
        case 'record': {
          required('record'); const r = state.records.find(r => r.recordId === a.record[0]);
          if (!r) throw new Error('Unknown record ID'); return r;
        }
        case 'associate': required('record', 'official'); return associate(state, reader, a.record[0], a.official);
        case 'inventory': required('record', 'official'); return inventory(state, reader, a.record[0], a.official);
        case 'report': required('judgments'); return produce(root, state, reader, await readJson(a.judgments));
        default: throw new Error(`Unknown command ${command}; use --help`);
      }
    });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (e) { process.stderr.write(JSON.stringify({ error: e.message }) + '\n'); process.exitCode = 1; }
