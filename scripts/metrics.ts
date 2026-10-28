/**
 * pnpm metrics: turns the README's claims into numbers a stranger can re-run.
 *
 *  1. Runs the whole vitest suite with the JSON reporter and reads the counts.
 *  2. Greps packages/*\/src for the patterns the mitigations forbid.
 *  3. Counts lines in the connect layer.
 *  4. Prints a markdown table and writes it to docs/metrics.md and into README.md
 *     between the metrics markers, so the README cannot drift from the output.
 *
 * Exits non-zero if any "must be 0" row is not 0 or any test fails.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { PROVIDER_DEFS } from '../packages/backend/src/provider-registry.js';

const ROOT = join(import.meta.dirname, '..');
const SENSITIVE = /token|secret|password|passwd|api[_-]?key|authorization|credentials/i;

// The pinned suite composition (see README). Printed next to the actual counts.
const EXPECTED_GROUPS: Record<string, number> = {
  state: 4,
  'pending-connection': 9,
  'page-token-vault': 7,
  'popup-completion': 6,
  'redirect-flow': 5,
  'embedded-flow': 4,
  'callback-page-flow': 5,
  redaction: 4,
  'all-providers': 13,
  'failure-modes': 11,
};

// --- 1. Test suite ----------------------------------------------------------

interface Assertion {
  ancestorTitles: string[];
  title: string;
  status: string;
}
interface Report {
  numTotalTests: number;
  numPassedTests: number;
  testResults: Array<{ assertionResults: Assertion[] }>;
}

function runSuite(): Report {
  const outFile = join(mkdtempSync(join(tmpdir(), 'oauth-demo-metrics-')), 'vitest.json');
  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(process.execPath, [vitest, 'run', '--reporter=json', `--outputFile=${outFile}`], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  if (!existsSync(outFile)) {
    console.error(run.stderr || run.stdout);
    throw new Error('vitest did not produce a JSON report');
  }
  return JSON.parse(readFileSync(outFile, 'utf8')) as Report;
}

// --- 2. Source scan ---------------------------------------------------------

interface SourceFile {
  pkg: 'backend' | 'frontend';
  rel: string;
  text: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : /\.(ts|tsx)$/.test(name) ? [abs] : [];
  });
}

const sources: SourceFile[] = (['backend', 'frontend'] as const).flatMap((pkg) =>
  walk(join(ROOT, 'packages', pkg, 'src')).map((abs) => ({
    pkg,
    rel: relative(ROOT, abs).split(sep).join('/'),
    text: readFileSync(abs, 'utf8'),
  })),
);

function hits(re: RegExp, filter: (f: SourceFile) => boolean = () => true): string[] {
  const found: string[] = [];
  for (const f of sources.filter(filter)) {
    f.text.split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(re)) found.push(`${f.rel}:${i + 1}: ${m[0]}`);
    });
  }
  return found;
}

const frontend = (f: SourceFile) => f.pkg === 'frontend';

const credentialUrlHits = [
  ...hits(/searchParams\.(?:set|append)\(\s*['"`]([^'"`]+)['"`]/g).filter((h) => SENSITIVE.test(h.split('searchParams')[1] ?? '')),
  ...hits(/[?&](?:access_token|refresh_token|id_token|client_secret|api_?key|password|credentials|token)=/gi),
];
const pageTokenHits = [
  ...hits(/access_token/g, frontend),
  ...hits(/fetch[^\n]*access_token/g, frontend),
  ...hits(/metaData\.access_token/g),
];
const popupClosedHits = hits(/\.closed\b/g);
const setIntervalHits = hits(/\bsetInterval\s*\(/g);
const hardcodedIdHits = [
  ...hits(/\b(?:client_?id|app_?id|config_?id|solution_?id|tenant_?id)\b['"]?\s*[:=]\s*['"`][^'"`$\s]{4,}['"`]/gi),
  ...hits(/['"`]\d{9,}['"`]/g),
];
const alertHits = hits(/\balert\s*\(/g);

// --- 3. Connect-layer size ---------------------------------------------------

const CONNECT_LAYER = /oauth|pending|page-token|state|redact/i;
const connectFiles = sources.filter((f) => CONNECT_LAYER.test(f.rel.split('/').pop()!));
const connectLoc = connectFiles.reduce((n, f) => n + f.text.split(/\r?\n/).filter((l) => l.trim() !== '').length, 0);

// --- 4. Report ----------------------------------------------------------------

const report = runSuite();
const assertions = report.testResults.flatMap((r) => r.assertionResults);
const group = (a: Assertion) => a.ancestorTitles[0] ?? '(none)';

const providerPassing = new Set(
  assertions
    .filter((a) => group(a) === 'all-providers' && a.status === 'passed')
    .map((a) => PROVIDER_DEFS.find((p) => a.title.startsWith(`${p.id} `))?.id)
    .filter(Boolean),
);
const noTokenTestPassed = assertions.some((a) => a.title.startsWith('FM-11') && a.status === 'passed');

type Row = [metric: string, value: string, method: string, cls: 'Verified' | 'Note'];
const zeroRows: Array<[string, string[], string]> = [
  ['Credential fields in URLs', credentialUrlHits, '`searchParams.set/append` with a credential-shaped key, or `?token=`-style literals, in `packages/*/src`'],
  ['Page tokens in browser', pageTokenHits, '`access_token` / `fetch…access_token` in frontend src, `metaData.access_token` anywhere; plus the FM-11 DOM/storage test'],
  ['popup.closed usages', popupClosedHits, '`.closed` property reads in `packages/*/src`'],
  ['setInterval usages (connect area)', setIntervalHits, '`setInterval(` in `packages/*/src` (whole tree, a superset of the connect area)'],
  ['Hard-coded provider IDs', hardcodedIdHits, 'quoted literals assigned to client/app/config/solution/tenant ids, or 9+ digit quoted numbers, in `packages/*/src`'],
  ['alert() usages', alertHits, '`alert(` in `packages/*/src`'],
];

const rows: Row[] = [
  [
    'Flows with verified state',
    `${providerPassing.size} / ${PROVIDER_DEFS.length}`,
    'providers whose `all-providers` case passed (flow completes; tampered state refused) / registry size',
    'Verified',
  ],
  ...zeroRows.map(([metric, found, method]): Row => {
    const value = metric === 'Page tokens in browser' && !noTokenTestPassed ? `${found.length} (FM-11 FAILED)` : String(found.length);
    return [metric, value, method, 'Verified'];
  }),
  ['Connect-layer LOC', String(connectLoc), `non-blank lines in ${connectFiles.length} src files whose name matches \`${CONNECT_LAYER.source}\``, 'Verified'],
  ['Test cases', String(report.numTotalTests), 'vitest JSON reporter, both packages', 'Verified'],
  ['Tests passing', `${report.numPassedTests} / ${report.numTotalTests}`, 'vitest JSON reporter, both packages', 'Verified'],
  ['Production connect success rate', 'not claimed', 'needs production telemetry; this repo has no production traffic', 'Note'],
  ['Time-to-connect / latency', 'not claimed', 'needs real-user timing; a local mock IdP says nothing about it', 'Note'],
  ['Support-ticket volume', 'not claimed', 'needs a ticketing system; out of scope', 'Note'],
];

const groupNames = [...new Set([...Object.keys(EXPECTED_GROUPS), ...assertions.map(group)])];
const groupRows = groupNames.map((name) => {
  const inGroup = assertions.filter((a) => group(a) === name);
  return [name, String(EXPECTED_GROUPS[name] ?? 0), String(inGroup.length), String(inGroup.filter((a) => a.status === 'passed').length)];
});

// GFM splits cells on "|" even inside code spans, so escape it.
const cell = (s: string) => s.replace(/\|/g, '\\|');
const table = (header: string[], body: string[][]) =>
  [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

const output = [
  table(['Metric', 'Value', 'Method', 'Class'], rows),
  '',
  table(['Test group', 'Pinned', 'Actual', 'Passing'], groupRows),
].join('\n');

console.log(output);

writeFileSync(
  join(ROOT, 'docs', 'metrics.md'),
  `# Metrics\n\nGenerated by \`pnpm metrics\` (scripts/metrics.ts). Do not edit by hand.\n\n${output}\n`,
);

const readmePath = join(ROOT, 'README.md');
const block = /(<!-- metrics:start -->\r?\n)[\s\S]*?(\r?\n<!-- metrics:end -->)/;
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, 'utf8');
  if (block.test(readme)) writeFileSync(readmePath, readme.replace(block, (_m, open: string, close: string) => `${open}${output}${close}`));
}

const failures = [
  ...zeroRows.filter(([, found]) => found.length > 0).map(([metric, found]) => `${metric}:\n  ${found.join('\n  ')}`),
  ...(report.numPassedTests !== report.numTotalTests ? ['Tests failing'] : []),
  ...(providerPassing.size !== PROVIDER_DEFS.length ? ['Not every provider passed all-providers'] : []),
  ...(!noTokenTestPassed ? ['FM-11 no-token-in-browser did not pass'] : []),
];
if (failures.length > 0) {
  console.error(`\nmetrics: FAILED\n${failures.join('\n')}`);
  process.exit(1);
}
