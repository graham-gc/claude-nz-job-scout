#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { readJson, put, rootAt } from '../src/store.mjs';
import { start, inRun, discover, index, details, associate, inventory, ticket, searchResult, endRun } from '../src/engine.mjs';
import { produce } from '../src/report.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const help = `NZ Job Scout v1 (development)
All commands run in the target project, not the plugin cache. JSON output only.
  version
  start --input request.json --resume /absolute/resume.pdf [--new-request]
  discover --run RUN_ID
  index --run RUN_ID [--offset 100]
  search-ticket --run RUN_ID
  search-result --run RUN_ID --ticket N [--url HTTPS_URL ... | --error MESSAGE]
  details --run RUN_ID --record RECORD_ID [--record RECORD_ID ...]
  record --run RUN_ID --record RECORD_ID
  associate --run RUN_ID --record RECORD_ID --official HTTPS_CAREERS_URL
  inventory --run RUN_ID --record RECORD_ID --official HTTPS_CAREERS_URL
  report --run RUN_ID --judgments judgments.json
  end --run RUN_ID
Optional --project /absolute/project on every command. No cleanup, login, shell-fetch,
plugin installation, application submission or source-editing subcommands.`;
try {
  const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string' }, input: { type: 'string' }, resume: { type: 'string' }, run: { type: 'string' },
    ticket: { type: 'string' }, url: { type: 'string', multiple: true }, error: { type: 'string' },
    record: { type: 'string', multiple: true }, official: { type: 'string' }, judgments: { type: 'string' },
    offset: { type: 'string' }, help: { type: 'boolean' }, 'new-request': { type: 'boolean' },
  } });
  const command = positionals[0], project = a.project ?? process.cwd();
  if (a.help || !command) { process.stdout.write(help + '\n'); process.exit(0); }
  const required = (...names) => { for (const name of names) if (!a[name]) throw new Error(`Missing --${name}; use --help`); };
  let result;
  if (command === 'version') {
    // Report the version of the code that is actually running, not of some cached copy.
    const read = async (...parts) => { try { return JSON.parse(await readFile(join(pluginRoot, ...parts), 'utf8')); } catch { return null; } };
    const manifest = await read('.claude-plugin', 'plugin.json');
    const pkg = await read('package.json');
    result = {
      version: manifest?.version ?? pkg?.version ?? null,
      pluginRoot,
      manifestVersion: manifest?.version ?? null,
      packageVersion: pkg?.version ?? null,
      consistent: Boolean(manifest?.version && pkg?.version && manifest.version === pkg.version),
    };
  }
  else if (command === 'start') {
    required('input', 'resume');
    const root = await rootAt(project);
    // The path is resolved inside the project, because the project's real path
    // and the path the caller typed can differ through a symlink.
    const inputPath = isAbsolute(a.input) ? a.input : join(root, a.input);
    const input = await readJson(inputPath);
    result = await start(project, input, a.resume, { newRequest: a['new-request'] === true });
    // The request id is written back into the request file, so that the
    // continuation runs of this request keep the same id and the same budget
    // without the caller having to carry it.
    if (result.requestId && input.requestId !== result.requestId) {
      await put(root, inputPath, { ...input, requestId: result.requestId }, { replace: true });
      result.requestIdWrittenTo = inputPath;
    }
  }
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
        // Closing an abandoned run by hand: it will never report, but it must
        // not keep the request from continuing.
        case 'end': return endRun(state);
        default: throw new Error(`Unknown command ${command}; use --help`);
      }
    });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (e) { process.stderr.write(JSON.stringify({ error: e.message }) + '\n'); process.exitCode = 1; }
