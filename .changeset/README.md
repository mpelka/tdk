# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
Run `bun changeset` to record a version bump for a package, then
`bun changeset version` to apply pending changesets.

Publishing is deferred — every package is currently `private: true` while TDK is
developed independently. Flip `private` off on the packages you intend to publish
(and set the Artifactory registry) when ready.
