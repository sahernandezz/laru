# Laru — the tool's own folder

This folder is Laru itself: the code of the tool, installed from GitHub. The work is not here. It lives in a **workspace**:
a folder with `laru.yaml`, `envs/`, `docs/` and its own `CLAUDE.md` / `AGENTS.md`, which documents one application, runs
its environments and keeps the evidence of its flows.

## Where the work is
- The session starts with the workspace in use (the one opened last in Laru): its name and folder, where Laru reaches
  Docker, its envs and their state, its flows with their last result, the person's working agreement and the whole guide.
  Follow that guide: it is the same one the workspace's own `CLAUDE.md` holds.
- `laru workspace list` lists every workspace on this machine; `LARU_WORKSPACE=<id>` or `--ws <id>` picks another.
- Laru's tools (MCP server `laru`, declared in `.mcp.json`, or `laru <command>` in the shell) act on the workspace in use.
  Its files are read by their path in that folder.

## What never happens here
- Never edit Laru's code to get past something: it is the installed tool and an update replaces it. Say what failed,
  with the command and its output, so it is fixed in Laru.
- Docker is Laru's to reach, not your shell's: Laru may run where your shell does not see Docker (Windows with the
  engine inside WSL, another DOCKER_HOST). Never conclude there is no Docker from `docker` in your shell, and never run
  docker or compose on Laru's envs: ask `env_status`, or `laru doctor` for the machine.
- One flow, its own env: a flow is written, fixed and played in `f-<flow>` (`flow_env`), never on an env other flows or
  a person are using.
