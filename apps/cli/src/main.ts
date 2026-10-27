import { run } from './cli.ts';

// Laru runs inside WSL2 on Windows: from a Windows shell its paths, its Docker and its key store are not the ones it needs.
if (process.platform === 'win32') {
  process.stderr.write([
    'laru: on Windows, Laru runs inside WSL2, not in PowerShell or cmd.',
    '  1. Open your WSL terminal (e.g. Ubuntu): wsl',
    '  2. Install Node 24, pnpm and Docker there (Docker Engine in the distribution, or Docker Desktop with its WSL integration)',
    '  3. Clone Laru and your workspaces under ~/ (the Linux filesystem), not /mnt/c',
    '  4. Run laru from that terminal; `laru doctor` checks the rest',
    '',
  ].join('\n'));
  process.exitCode = 1;
} else {
  process.exitCode = await run(process.argv.slice(2));
}
