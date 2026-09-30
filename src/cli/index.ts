import { run } from './run.js';

const code = await run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});
process.exitCode = code;
