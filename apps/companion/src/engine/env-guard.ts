// Imported first by main.ts, before any other module of the Engine runs. A
// release Engine started with a variable outside its allowlist exits at once
// (environment.ts). Development builds run from tests and tools with whatever
// environment they have; they hold no release token.
import { BUILD } from '../build-info.ts';
import { unexpectedVariables } from './environment.ts';

if (BUILD.mode === 'release') {
  const unexpected = unexpectedVariables(process.env);
  if (unexpected.length > 0) {
    process.stderr.write(`Draft Tide Engine: refusing to start with ${unexpected.join(', ')} in the environment\n`);
    process.exit(2);
  }
}
