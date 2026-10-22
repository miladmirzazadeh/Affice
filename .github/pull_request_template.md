## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem it solves, or the reason for the approach. -->

## How you checked it

- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm test` passes, with the build done so the launcher and Trella tests run
- [ ] I tried it in the browser (say what you did, and at which width if it is a screen)

## Checklist

- [ ] No real Claude session is started by a test, and tests do not touch the real home folder
- [ ] Text from a server, a manager, a file or a user reaches the page only as `textContent`
- [ ] No new dependency, or it is explained above
- [ ] No em dashes or en dashes in code, comments, UI text or docs
- [ ] Docs are updated if the behavior, a command, a port or a variable changed
- [ ] A change to `shared/` is explained, because it affects both the server and the page
