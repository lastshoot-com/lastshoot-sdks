# LastShoot SDKs

Official client libraries and MCP server for the [LastShoot](https://www.lastshoot.com) API.

| Folder | Package | What |
| --- | --- | --- |
| `python/` | `lastshoot` (PyPI) | Python SDK, sync + asyncio, `httpx` |
| `typescript/` | `@lastshoot/sdk` (npm) | TypeScript/JS SDK, ESM + CJS, zero deps |
| `mcp/` | `@lastshoot/mcp` (npm) | MCP server for Claude, Cursor and other MCP clients |
| `spec/openapi.json` | | Snapshot of https://api.lastshoot.com/openapi.json |
| `scripts/codegen.py` | | Generates the endpoint layer of both SDKs from the spec |

## Develop

```bash
npm install                               # links typescript/ and mcp/ as workspaces
npm run typecheck && npm test && npm run build

cd python && python -m venv .venv && .venv/Scripts/python -m pip install -e ".[dev]"
.venv/Scripts/python -m pytest -q
```

When the API changes: download the spec into `spec/openapi.json`, run
`python scripts/codegen.py`, and fix whatever the tests flag. `codegen.py` exits with an error
if the spec gains or loses a job endpoint that `ENDPOINTS` does not list.

Publishing: see [PUBLISHING.md](PUBLISHING.md).
