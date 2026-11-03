# Third-party notices

MERQO bundles or depends on the following components. Their licences apply to those
components, not to MERQO's own source.

| Component | Version | Licence | Used for |
| --- | --- | --- | --- |
| Electron | 33.x | MIT | Desktop runtime |
| React / React DOM | 18.3 | MIT | User interface |
| Vite | 5.4 | MIT | Renderer bundling (build only) |
| esbuild | 0.24 | MIT | Main/preload bundling (build only) |
| better-sqlite3 | 11.x | MIT | SQLite driver in the packaged app |
| SQLite | 3.4x | Public domain | Embedded database engine |
| Vitest | 2.1 | MIT | Test runner (development only) |
| electron-builder | 25.x | MIT | NSIS installer (build only) |
| Noto Sans Bengali | 5.x | SIL Open Font License 1.1 | Bengali interface and receipts |
| Inter | 5.x | SIL Open Font License 1.1 | Latin numerals and UI labels |
| postject | 1.0.0-alpha | MIT | Node SEA injection for owner tools (build only) |

Font files are redistributed under the SIL OFL 1.1, which permits bundling in an
application; the fonts themselves are not sold or relicensed.

`node:sqlite` is part of the Node.js runtime (MIT) and is used only by the test
suite and headless tooling, never by the packaged desktop application.
