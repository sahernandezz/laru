import { run } from './cli.ts';

process.exitCode = await run(process.argv.slice(2));
