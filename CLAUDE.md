# CLAUDE.md

See [AGENTS.md](AGENTS.md). It is the guide for working on this package and
applies here in full: the layout, the invariants, how to run the suite, how to
update to a new Centrifugo API, and the list of things that look wrong but are
deliberate.

Three points from it are worth repeating, because they are the ones most easily
lost:

- **Never edit `src/generated/` or `API.md`.** Change `proto/`, `gen/` or a
  doc comment, then run `npm run generate` and `npm run docs`.
- **Web standards only in `src/`**: no `node:` imports, no dependencies.
- **Every call rejects unless it did everything asked**: a broadcast or batch
  in which some parts failed rejects, carrying every part's outcome.

Run `npm run check` before reporting a change as done, and
`npm run test:integration` with Centrifugo running for a change to the
transport, errors, batching or handlers.
