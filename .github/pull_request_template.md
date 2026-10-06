## What changed

## How I tested it
<!-- Real app? A throwaway USB drive for anything that touches the disk? -->

## Checklist
- [ ] `node --check` passes on changed files
- [ ] No Node access added to the renderer; new IPC inputs are validated
- [ ] Disk operations are cancelable and never destroy the previous version early
