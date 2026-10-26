# laru/runner: Playwright with its browsers, plus @playwright/test at the same version, and a tsconfig that
# maps @laru/flow to Laru's packages (mounted read-only at /ks/packages) and @support/* to the workspace.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
WORKDIR /ks
RUN npm init -y >/dev/null && npm i --no-audit --no-fund --loglevel=error @playwright/test@1.64.1
COPY tsconfig.json /ks/tsconfig.json
