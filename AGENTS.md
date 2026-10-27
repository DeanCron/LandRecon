# Agent guidelines

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

## Git setup in agent runs

Agent runs may not read the shared global git config. In each fresh clone,
before committing:

```sh
git config user.name "lr-bot-dc"
git config user.email "348483493+lr-bot-dc@users.noreply.github.com"
```

Push with the `gh` credential helper (never put a token in a remote URL):

```sh
git -c credential.helper='!gh auth git-credential' push -u origin <branch>
```
