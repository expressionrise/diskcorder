'use strict';

/* Creates the labels, milestones and issues described in docs/roadmap/issues.json
   on GitHub using the `gh` CLI. Safe to re-run: existing milestones and issues
   (matched by title) are skipped.

   Usage:   node scripts/create-issues.js [--dry-run]
   Needs:   `gh auth login` as an account with write access to the repository. */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'expressionrise/diskcorder';
const dry = process.argv.includes('--dry-run');
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'roadmap', 'issues.json'), 'utf8'));

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const who = gh(['api', 'user', '--jq', '.login']);
const perm = JSON.parse(gh(['api', `repos/${REPO}`, '--jq', '.permissions']));
console.log(`Logged in as ${who}; push access: ${perm.push}`);
if (!perm.push && !dry) {
  console.error('This account cannot manage labels/milestones on the repo. Run `gh auth login` as the repo owner.');
  process.exit(1);
}

// labels
for (const l of spec.labels) {
  console.log(`label ${l.name}`);
  if (!dry) gh(['label', 'create', l.name, '--color', l.color, '--description', l.description, '--force', '-R', REPO]);
}

// milestones
const haveMs = JSON.parse(gh(['api', `repos/${REPO}/milestones?state=all`, '--jq', '[.[].title]']));
for (const m of spec.milestones) {
  if (haveMs.includes(m.title)) { console.log(`milestone ${m.title} (exists)`); continue; }
  console.log(`milestone ${m.title}`);
  if (!dry) gh(['api', `repos/${REPO}/milestones`, '-f', `title=${m.title}`, '-f', `description=${m.description}`]);
}

// issues
const haveIssues = JSON.parse(gh(['issue', 'list', '-R', REPO, '--state', 'all', '--limit', '500', '--json', 'title'])).map(i => i.title);
const created = [];
for (const i of spec.issues) {
  if (haveIssues.includes(i.title)) { console.log(`issue "${i.title}" (exists)`); continue; }
  console.log(`issue "${i.title}"  [${i.milestone}; ${i.labels.join(', ')}]`);
  if (dry) continue;
  const file = path.join(os.tmpdir(), `dc-issue-${Date.now()}.md`);
  fs.writeFileSync(file, i.body);
  try {
    const url = gh(['issue', 'create', '-R', REPO, '--title', i.title, '--body-file', file,
      '--label', i.labels.join(','), '--milestone', i.milestone]);
    created.push(`${url}  ${i.title}`);
  } finally { fs.rmSync(file, { force: true }); }
}
console.log(created.length ? `\nCreated ${created.length} issues:\n${created.join('\n')}` : '\nNothing new to create.');
