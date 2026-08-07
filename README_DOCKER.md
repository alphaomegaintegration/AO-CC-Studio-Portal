# Continuum Code Studio — Docker

This configuration runs the Studio UI, HTTP bridge, and stdio MCP server in one
container. The HTTP bridge starts an MCP process inside the container whenever
the UI calls a CodeIntent tool.

## Requirements

- Docker Desktop, Docker Engine, or another Docker-compatible runtime
- Docker Compose v2 (`docker compose`)

No local Node.js or npm installation is required.

## Start the Studio

From the project directory:

```bash
docker compose up --build -d
```

Open:

```text
http://localhost:8787/studio
```

Check the container and application health:

```bash
docker compose ps
curl -s http://localhost:8787/api/health
```

Ask the MCP-backed API a question:

```bash
curl -s http://localhost:8787/api/ask \
  -H 'content-type: application/json' \
  -d '{"question":"Why don\u0027t dormant accounts accrue interest?"}'
```

Follow logs:

```bash
docker compose logs -f studio
```

Stop and remove the container:

```bash
docker compose down
```

## Use another host port

If port 8787 is already in use:

```bash
STUDIO_PORT=8788 docker compose up --build -d
```

Then open `http://localhost:8788/studio`.

## Run without Compose

```bash
docker build -t ao-continuum-code-studio:local .
docker run --rm -d \
  --name ao-continuum-code-studio \
  -p 8787:8787 \
  ao-continuum-code-studio:local
```

## Run only the MCP sanity test

The same five-tool sanity test runs while the image is built. It can also be
run on demand:

```bash
docker compose run --rm --no-deps studio node test.mjs
```

## Files added for containerization

- `Dockerfile` builds the Node 20 image, installs locked production
  dependencies, runs the MCP sanity test, and defines the HTTP health check.
- `compose.yaml` publishes the Studio and applies a read-only filesystem,
  dropped Linux capabilities, and automatic restart behavior.
- `.dockerignore` keeps local dependencies, editor files, documentation, and
  demo-workspace content out of the runtime build context.

The optional Claude Code and VS Code setup in `README_PRODUCT_BUILD.md` remains
a separate host integration. The containerized Studio itself—including its
internal MCP bridge—does not require either IDE integration.
