# Agent guidelines

<!-- Smoke-test comment added by LAN-36. -->

Applies to all AI agents working on this repository.

- **Never push to or open PRs against `main`.** `main` deploys to production.
  Work on a feature branch and open a PR into `staging`. Only a human promotes
  `staging` to `main`.
- Never force-push, delete branches you didn't create, or change branch
  protection, workflows' deploy targets, or repository secrets/variables.
- Before opening a PR run `npm run lint`, `npm test`, `npm run test:server`
  and `npm run build`; all must pass.
- Don't add or change paid third-party API usage (TomTom, Google, Azure)
  without calling it out in the PR description.
- Keep PRs small and focused; describe what changed and how to verify it on
  the staging site.
- Never commit secrets or API keys.
