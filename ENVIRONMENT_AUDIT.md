# MERQO — Environment Audit (Phase 0)

**Date of audit:** 2026-11-03
**Auditor:** MERQO engineering agent
**Repository:** `heyiamshohan-cloud/merqo-business-suite` (branch `arena/e9988ac4-merqo-business-suite`, forked from `66db716` on `main`)
**Repository state at start:** public, non-empty (only `README.md`), 0 KB, no workflows, no releases.

This document records what was **actually observed** in the development environment. Nothing
here is assumed. Where a capability is missing, the consequence and the workaround are stated.

---

## 1. Host environment

| Item | Observed value |
| --- | --- |
| OS | Debian GNU/Linux 12 (bookworm), kernel 6.1.158+, x86_64 |
| CPU | 2 vCPU |
| RAM | 3.8 GiB (no swap) |
| Disk | 21 GB total, ~20 GB free at start |
| Shell | non-interactive bash, no controlling TTY |
| Display server | none (headless) |

**Consequence:** there is no Windows machine and no graphical session in the development
sandbox. Any Electron window cannot be launched here, and physical printer/scanner hardware
cannot be attached.

## 2. Toolchain inventory

| Tool | Status | Notes |
| --- | --- | --- |
| `dotnet` / `msbuild` / `mono` | ❌ not installed | no .NET SDK anywhere on the image |
| apt / `deb.debian.org` | ❌ unreachable | cannot install system packages |
| `packages.microsoft.com` | ❌ unreachable | cannot add the Microsoft package feed |
| `api.nuget.org` | ❌ unreachable | **NuGet restore is impossible** |
| `dotnet.microsoft.com`, `builds.dotnet.microsoft.com` | ❌ unreachable | SDK cannot be bootstrapped |
| `node` | ✅ v22.22.3 | |
| `npm` | ✅ 10.9.8, `registry.npmjs.org` reachable | full install works |
| `pypi.org` | ✅ reachable | |
| `python3` | ✅ 3.11.2 | used for build scripting |
| `gcc` | ✅ 12.2.1 | present but native modules cannot fetch node headers (`nodejs.org` blocked) |
| `git` | ✅ 2.39.5 | push to `origin` works |
| `gh` | ✅ 2.23.0 | authenticated as `heyiamshohan-cloud` |
| Wine / `makensis` | ❌ not installed | no local Windows packaging |
| `node:sqlite` (built into Node) | ✅ SQLite 3.51.3 | no native build required |
| `better-sqlite3` (npm, prebuilt) | ❌ prebuild download blocked | must compile in CI or use `node:sqlite` |
| `objects.githubusercontent.com` | ❌ blocked | **binary release-asset downloads fail** (Electron binary, NSIS tooling) |

Verified reachability probe (HTTP status):

```
api.github.com                       200
github.com                           200
codeload.github.com                  200
registry.npmjs.org                   200
pypi.org                             200
objects.githubusercontent.com        000  (blocked)
api.nuget.org                        000  (blocked)
dot.net                              000  (blocked)
deb.debian.org                       000  (blocked)
```

## 3. GitHub access

| Capability | Status |
| --- | --- |
| Read repository metadata | ✅ |
| Commit and push to the session branch | ✅ (verified: commit `01e8ea5` pushed) |
| Create releases / upload assets | ✅ expected — token has repo write; validated when the release is published |
| Read Actions permissions endpoint | ⚠️ `403 Resource not accessible by integration` (endpoint not exposed to this token) |
| Trigger workflows | ⚠️ cannot be verified until a workflow file is pushed; the token's `workflow` scope is unknown |
| Change repository visibility | not attempted — explicitly out of scope, repository must stay public |

**Risk recorded:** if the token lacks the `workflow` scope, pushing `.github/workflows/*`
will be rejected. Mitigation: attempt the push early and report precisely if it fails.

## 4. Consequences for the build strategy

The audit drives three hard decisions.

### 4.1 A .NET/C#/WPF implementation could not be verified at all

A WPF application is a legitimate choice for this product, but in this environment it would
mean writing tens of thousands of lines of C# that **cannot be compiled, type-checked or
tested even once** locally — NuGet is unreachable and no SDK exists. Every mistake would only
surface in a remote Windows CI run, and the business logic could never be executed against a
database before shipping. That is an unacceptable risk for financial software.

### 4.2 The business core must be executable here

The chosen stack (TypeScript + Node) allows the **entire business core to be compiled,
type-checked and executed locally** against a real SQLite engine, with an automated test suite
that runs on every change. This is the single most important property for an accounting
product: the money rules must be provably correct before anyone packages a binary.

### 4.3 Windows artefacts are produced in CI, not locally

Because `objects.githubusercontent.com` is blocked, the Electron runtime and the NSIS toolchain
cannot be downloaded into the sandbox. Windows executables and the installer **must** be built
on `windows-latest` GitHub Actions runners (which have unrestricted internet). This is
planned, not pretended: see `.github/workflows/`.

**Never** will a Linux binary be presented as a Windows executable in this project.

## 5. What therefore *cannot* be verified in this environment

The following remain genuinely untested until executed on real hardware/Windows, and are
tracked as such in `REQUIREMENTS_TRACEABILITY.md` and `PROJECT_PROGRESS.md`:

1. Launching the Electron application window.
2. Any visual/interaction QA performed by a human on Windows.
3. Installation, uninstall and first-run behaviour of the installer on a clean Windows machine.
4. Printing on physical 58 mm / 80 mm thermal printers.
5. Scanning with physical USB/Bluetooth barcode scanners.
6. Code signing with an Authenticode certificate (no certificate is available).

Every one of these has a documented manual test procedure in `docs/testing/`.

## 6. Verification capability summary

| Verification type | Possible here |
| --- | --- |
| TypeScript strict type-check | ✅ |
| Unit tests (money, accounting, inventory, sales, purchase, returns, payments, expenses) | ✅ |
| Integration tests against real SQLite (in-memory and on-disk) | ✅ |
| Migration, backup/restore, corruption-handling tests | ✅ |
| Licence signature/crypto tests (Ed25519 via `node:crypto`) | ✅ |
| Security tests (injection, tampering, path traversal) | ✅ |
| Performance benchmarks against large datasets | ✅ |
| Renderer (React) type-check and production bundle build | ✅ |
| Electron main-process bundle build (esbuild) | ✅ |
| Windows `.exe`, installer, checksums | ⚠️ CI only |
| Physical printer/scanner, installer UX, code signing | ❌ not available |
