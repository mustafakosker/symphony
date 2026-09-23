import { realpath,writeFile } from 'node:fs/promises';
import { dirname,resolve,sep } from 'node:path';
import { loadSettings } from '../dist-server/server/config/settings.js';
import { runProjectProbe,evaluateProjectProbe } from '../dist-server/server/projects/probe.js';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--config'||args[2]!=='--output')throw new Error('Usage: node scripts/verify-project-access.mjs --config <disposable-host-config> --output <new-evidence-file>');
const config=resolve(args[1]),output=resolve(args[3]),settings=await loadSettings(config),parent=await realpath(dirname(output));
if(settings.projectsRoot){const root=await realpath(settings.projectsRoot);if(parent===root||parent.startsWith(root+sep))throw new Error('Probe evidence must be outside the connected source root');}
if(output===settings.verifiedProfilesPath)throw new Error('Probe evidence cannot replace an installed attestation');
const observation=await runProjectProbe(config),evaluation=evaluateProjectProbe(observation);
await writeFile(output,JSON.stringify({observation,evaluation},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,passed:evaluation.passed,limitations:observation.limitations},null,2));
process.exitCode=evaluation.passed?0:1;
