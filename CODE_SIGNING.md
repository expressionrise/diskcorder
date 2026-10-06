# Code signing policy

Windows releases of Diskcorder are built from this repository by a fully automated GitHub
Actions workflow (`.github/workflows/release.yml`), so every released binary can be traced
back to the source code at its tag.

**Status:** code signing is being set up. Until it is active, releases are unsigned and
Windows SmartScreen may show an "unknown publisher" warning. You can verify a build by
comparing it with the source or by building it yourself (`npm run dist`).

## Planned arrangement

Once approved, free code signing will be provided by [SignPath.io](https://signpath.io/),
with the certificate issued by the [SignPath Foundation](https://signpath.org/).

- **Committers and reviewers:** the maintainers listed under
  [contributors](https://github.com/expressionrise/diskcorder/graphs/contributors).
- **Approvers:** the repository owner, [@expressionrise](https://github.com/expressionrise).
- Only official release builds (from tagged commits on `main`) are signed; the
  signed artifacts are the installer and the portable executable.

## Privacy

Diskcorder does not send any data over the network. See the
[README](README.md#how-it-works) and [SECURITY.md](SECURITY.md).

## Third-party software

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
