# Changesets

This folder holds [changesets](https://changesets.dev): small Markdown files that describe a change and the version bump it needs (`patch`, `minor`, or `major`). Add one with every pull request that changes published behavior:

```bash
npx changeset
```

When changes reach `main`, the release workflow turns pending changesets into a "Version Packages" pull request that bumps the version and updates `CHANGELOG.md`. Merging that pull request publishes the new version to npm.
