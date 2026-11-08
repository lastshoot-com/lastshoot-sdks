# @lastshoot/mcp

**[Website](https://www.lastshoot.com)** · **[Docs](https://www.lastshoot.com/docs)** · [API reference](https://api.lastshoot.com/docs) · [Get an API key](https://www.lastshoot.com/dashboard) · [GitHub](https://github.com/lastshoot-com/lastshoot-sdks)

[Model Context Protocol](https://modelcontextprotocol.io) server for
[LastShoot](https://www.lastshoot.com) AI product photography. It lets Claude, Cursor and other
MCP clients turn product photos into on-model shots, run virtual try-ons, change or remove
backgrounds, edit, upscale and generate images.

Runs locally over stdio. Needs Node.js 18+ and a LastShoot API key from the
[dashboard](https://www.lastshoot.com/dashboard).

## Tools

| Tool | What it does | API |
| --- | --- | --- |
| `upload_image` | Upload a local file, or copy an image from a URL, and get a hosted URL | `POST /upload/image/v1` |
| `product_to_model` | Product photo to an on-model photo | `POST /edit/image/v1` |
| `try_on` | Dress a person photo in a garment photo | `POST /creator/tryon/image/v1` |
| `change_background` | New background, subject kept intact | `POST /background/change/image/v1` |
| `remove_background` | Cut-out (transparent or solid colour, optional shadow) | `POST /background/remove/image/v1` |
| `edit_image` | Edit with a text instruction, one or more reference images | `POST /edit/image/v1` |
| `upscale_image` | Upscale 1x to 4x and enhance | `POST /upscale/image/v1` |
| `generate_image` | Text to image | `POST /generate/image/v1` |
| `get_job` | One status check: status, progress, result_url | `GET <endpoint>/status/{job_id}` |
| `wait_for_job` | Wait for a job and return its result_url | `GET <endpoint>/status/{job_id}` |

Every image input accepts a public URL or a local file path; local files are uploaded for you.
Compute tools wait for the result (default limit 300 s), send MCP progress notifications
(0-100) when the client asks for them, and return `result_url` plus a short summary. Pass
`wait: false` to get a `job_id` immediately, then call `wait_for_job`. Result URLs expire
within 24 hours.

Each call spends credits on your LastShoot account, like any API call.

## Setup

### Claude Desktop

Settings > Developer > Edit Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lastshoot": {
      "command": "npx",
      "args": ["-y", "@lastshoot/mcp"],
      "env": { "LASTSHOOT_API_KEY": "ls_live_xxxxxxxxxxxx" }
    }
  }
}
```

On Windows, if Claude Desktop cannot find `npx`, use
`"command": "cmd", "args": ["/c", "npx", "-y", "@lastshoot/mcp"]`. Restart Claude Desktop after
saving.

### Claude Code

```bash
claude mcp add lastshoot -e LASTSHOOT_API_KEY=ls_live_xxxxxxxxxxxx -- npx -y @lastshoot/mcp
```

Add `--scope user` to make it available in every project.

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "lastshoot": {
      "command": "npx",
      "args": ["-y", "@lastshoot/mcp"],
      "env": { "LASTSHOOT_API_KEY": "ls_live_xxxxxxxxxxxx" }
    }
  }
}
```

### Other clients

Any MCP client that can launch a stdio server: command `npx`, args `-y @lastshoot/mcp`,
environment `LASTSHOOT_API_KEY`. Optional: `LASTSHOOT_BASE_URL` (default
`https://api.lastshoot.com`).

## Example prompts

- "Put these earrings on a model: C:\photos\earrings.jpg"
- "Try this jacket (https://...) on this model photo (https://...), she's a woman."
- "Remove the background from ./shoe.png and put it on pure white with a soft shadow."
- "Upscale that result 2x."

## Use as a library

```ts
import { createServer } from "@lastshoot/mcp";
import { LastShoot } from "@lastshoot/sdk";

const server = createServer(new LastShoot(process.env.LASTSHOOT_API_KEY));
// connect any MCP transport: await server.connect(transport)
```

## License

MIT
