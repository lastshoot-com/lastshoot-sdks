# Publishing the LastShoot SDKs

Three packages, all at version **0.1.0**:

| Package | Registry | Folder | Install |
| --- | --- | --- | --- |
| `lastshoot` | PyPI | `python/` | `pip install lastshoot` |
| `@lastshoot/sdk` | npm | `typescript/` | `npm install @lastshoot/sdk` |
| `@lastshoot/mcp` | npm | `mcp/` | `npx -y @lastshoot/mcp` |

Nothing has been published yet. On 2026-11-08 `lastshoot` returned 404 on PyPI and both
`@lastshoot/*` names returned 404 on npm, so the names looked free. Claim them soon.

Publish order matters: **`@lastshoot/sdk` before `@lastshoot/mcp`**, because the MCP server
depends on `@lastshoot/sdk@^0.1.0` from the registry.

---

## 0. Pre-flight (run from the repo root)

```bash
git status                                   # clean tree
python scripts/codegen.py --check            # generated code matches spec/openapi.json
npm ci
npm run typecheck && npm test && npm run build
cd python
python -m venv .venv && .venv/Scripts/python -m pip install -e ".[dev]"    # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m pytest -q
.venv/Scripts/python -m mypy
```

If the live API changed, refresh the spec first, regenerate, and re-run the tests:

```bash
curl -s https://api.lastshoot.com/openapi.json -o spec/openapi.json
python scripts/codegen.py
```

## 1. npm: create the `@lastshoot` scope (one time)

1. Sign up or log in at https://www.npmjs.com. Turn on 2FA (Account > Two-Factor
   Authentication, "Authorization and publishing").
2. Create the organization: https://www.npmjs.com/org/create, name **`lastshoot`**, plan
   **Unlimited public packages (free)**. That org owns the `@lastshoot/` scope.
3. Optional: add teammates under the org's Members tab.

## 2. npm: publish

```bash
npm login                       # opens the browser; use the account that owns the org
npm whoami                      # check you're on the right account
npm org ls lastshoot            # you should be listed as owner

# SDK first
cd typescript
npm publish --access public     # prepublishOnly runs typecheck + tests + build
cd ..

# then the MCP server
cd mcp
npm publish --access public
cd ..
```

`--access public` is required the first time for a scoped package (it is also set in
`publishConfig`). npm will ask for a 2FA code.

Optional, recommended later: publish from GitHub Actions with
`npm publish --provenance --access public` and an npm automation token, so the packages show
a provenance badge.

## 3. PyPI: account, token, upload

1. Create an account at https://pypi.org/account/register/ and turn on 2FA (required to
   publish).
2. Optional dry run on TestPyPI first: separate account at https://test.pypi.org, then
   `twine upload --repository testpypi dist/*` and
   `pip install -i https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple lastshoot`.
3. Create an API token: https://pypi.org/manage/account/token/. For the very first upload
   the scope must be **"Entire account"** (the project does not exist yet). After the first
   release, delete it and create a token scoped to project `lastshoot`.
4. Build and upload:

```bash
cd python
rm -rf dist
.venv/Scripts/python -m build            # sdist + wheel
.venv/Scripts/python -m twine check dist/*
.venv/Scripts/python -m twine upload dist/*
#   username: __token__
#   password: pypi-...   (the API token)
```

To avoid pasting the token each time, put it in `~/.pypirc`:

```ini
[pypi]
username = __token__
password = pypi-XXXXXXXX
```

Later you can switch to PyPI Trusted Publishing from GitHub Actions and drop the token.

## 4. After publishing: verify

In a fresh folder or machine, without the repo:

```bash
# Python
python -m venv /tmp/ls && /tmp/ls/bin/pip install lastshoot==0.1.0
/tmp/ls/bin/python -c "from lastshoot import LastShoot; print(LastShoot('x').generate.image.__doc__.splitlines()[0])"

# TypeScript (ESM and CJS)
mkdir /tmp/lsjs && cd /tmp/lsjs && npm init -y && npm i @lastshoot/sdk@0.1.0
node --input-type=module -e "import { LastShoot } from '@lastshoot/sdk'; console.log(typeof new LastShoot('x').generate.image)"
node -e "const { LastShoot } = require('@lastshoot/sdk'); console.log(typeof new LastShoot('x').upload.image)"

# MCP: should print "ready on stdio" then wait (Ctrl+C to quit)
LASTSHOOT_API_KEY=x npx -y @lastshoot/mcp
```

Then, with a real API key (costs a few cents):

- [ ] Python: `LastShoot().upscale.image(input_image="<public image url>", scale=2).url` opens an image.
- [ ] TypeScript: same call with `await client.upscale.image({ inputImage, scale: 2 })`.
- [ ] Upload: `client.upload.image("local.jpg")` returns a URL that opens.
- [ ] Bad key gives `AuthenticationError`; a zero-balance key gives `InsufficientCreditsError`
      (402). Confirm the API really returns 401/402/429 status codes and that the error
      body's `detail` reads well. The OpenAPI spec does not document these responses.
- [ ] Claude Desktop or Claude Code with the README config: ask "remove the background from
      <url>" and get a result URL back; progress shows while it runs.
- [ ] Package pages look right: https://pypi.org/project/lastshoot/,
      https://www.npmjs.com/package/@lastshoot/sdk, https://www.npmjs.com/package/@lastshoot/mcp
      (README renders, license MIT, Node >= 18 / Python >= 3.9).
- [ ] Docs links work: lastshoot.com/docs/sdks/python and /typescript point at the live
      packages (the docs already say `pip install lastshoot` / `npm install @lastshoot/sdk`).
- [ ] Optional: list the MCP server in the MCP registry / Cursor directory.

## Releasing a new version

1. Bump the version in all places:
   - `python/pyproject.toml` and `python/src/lastshoot/_version.py`
   - `typescript/package.json` and `typescript/src/version.ts`
   - `mcp/package.json` and `SERVER_VERSION` in `mcp/src/server.ts` (and its `@lastshoot/sdk`
     range if the SDK had a breaking change)
2. Re-run the pre-flight checks, commit, tag (`git tag v0.1.1`), publish in the same order.
3. A published version can never be re-uploaded. Fix mistakes with a new patch version
   (`npm deprecate` / PyPI "yank" for bad ones).
