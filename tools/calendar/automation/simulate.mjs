import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import assert from 'node:assert/strict';
import {analyze,serialize,validateIntegrity} from './core.mjs';
import {verifyAnchoredHistory} from './official.mjs';
import {downloadPdf,githubClient,loadBase} from './network.mjs';
import {calendarRemoteDatasetSchema} from '../calendar-schema.mjs';

// No publishing implementation, dispatch input, write client or activation variable exists.
const {values}=parseArgs({options:{mode:{type:'string',default:'simulate'},out:{type:'string',default:'review'},pdf:{type:'string'},'base-snapshot':{type:'string'},python:{type:'string',default:process.env.CALENDAR_PDF_PYTHON??'python'}}});
if(values.mode!=='simulate')throw Error('Only simulation is installed. Publication is disabled.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(values.out);
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const validate=x=>calendarRemoteDatasetSchema.parse(x);
let temporary;
await mkdir(out,{recursive:true});
try {
 const checkedAt=new Date().toISOString();
 const base=values['base-snapshot']?await json(resolve(values['base-snapshot'])):await loadBase(githubClient(process.env.GITHUB_TOKEN));
 if(!base.state?.officialSchedule)throw Error('Reviewed official ledger is required.');
 validateIntegrity(base.calendar,validate);
 verifyAnchoredHistory(base.calendar.events,base.state);
 const sourcePolicy=await json(join(root,'automation/policy.json'));
 assert.deepEqual(base.state.historyAnchor,sourcePolicy.bootstrapAnchor,'Initial 702-event anchor changed; explicit review required.');
 temporary=await mkdtemp(join(tmpdir(),'titanshub-calendar-simulation-'));
 const pdf=values.pdf?resolve(values.pdf):join(temporary,'source.pdf');
 if(!values.pdf)await writeFile(pdf,await downloadPdf());
 const extracted=join(temporary,'extraction.json');
 const child=spawnSync(values.python,[join(root,'calendar_pdf/extract.py'),'--pdf',pdf,'--output',extracted],{encoding:'utf8',windowsHide:true,timeout:180000});
 if(child.error||child.status!==0)throw Error('PDF extraction failed; public files remain unchanged.');
 const extraction=await json(extracted);
 const {candidate,coverageState,report}=analyze(base.calendar,extraction,checkedAt,validate,await json(join(root,'calendar_pdf/profile.json')),base.state,sourcePolicy);
 assert.deepEqual(coverageState.officialSchedule,base.state.officialSchedule,'Reviewed official assertions must remain intact.');
 for(const event of base.calendar.events)assert.ok(candidate.events.some(e=>e.id===event.id),'Existing ID removed.');
 verifyAnchoredHistory(candidate.events,coverageState);
 for(const binding of coverageState.officialSchedule.eventBindings)assert.deepEqual(candidate.events.find(e=>e.id===binding.id),base.calendar.events.find(e=>e.id===binding.id),'Official event changed.');
 report.baseCommit=base.commit;
 report.publication='DISABLED — simulation only';
 report.baseEvents=base.calendar.events.length;
 report.historicalEventsPreserved=base.state.historyAnchor.count;
 report.officialAssertionsPreserved=true;
 const summary=[`# Shop Titans calendar — ${report.status}`,'',`Publication: **DÉSACTIVÉE / DISABLED**`,'',`Base: ${base.commit} (${report.baseEvents} events).`,`Analyzed: ${report.analyzedCoverage.from} — ${report.analyzedCoverage.to}.`,`Extracted: ${report.recognizedEvents}; new: ${report.newEvents}; unchanged: ${report.unchangedEvents}; corrected: ${report.modifiedEvents}.`,`Candidate: ${report.candidateEvents}; retained: ${report.retainedEvents}; deleted: ${report.deletedEvents}.`,`Historical anchor: ${report.historicalEventsPreserved} events, unchanged.`,`Excluded markers: ${report.excludedEvents}; equipment: ${report.nonEventMarkers}; superseded official forecasts: ${report.officialSuppressedPredictions.length}.`,`Conflicts: ${report.conflicts.length}; blockers: ${report.blockers.join(', ')||'none'}.`,`Incomplete days: ${report.uncoveredDates.join(', ')||'none'}.`,'','Official assertions and their exclusions are preserved. No public calendar, branch, release or version is written.','',`Candidate SHA-256: ${report.candidateSha256}`,`Ledger SHA-256: ${report.coverageStateSha256}`,''].join('\n');
 for(const [name,value] of Object.entries({'base.json':base,'extraction.json':extraction,'calendar.candidate.json':candidate,'calendar-state.candidate.json':coverageState,'report.json':report}))await writeFile(join(out,name),serialize(value));
 await writeFile(join(out,'report.md'),summary);
 if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,summary,{flag:'a'});
 console.log(summary);
 if(report.status!=='valid')process.exitCode=1;
}catch(error){
 const failure={status:'refused',publication:'DISABLED',message:error instanceof Error?error.message:'Simulation failed.'};
 await writeFile(join(out,'failure.json'),serialize(failure));
 if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,`\nSimulation failed: ${failure.message}\n\nPublication: **DÉSACTIVÉE**\n`,{flag:'a'});
 console.error(failure.message);process.exitCode=1;
}finally{
 if(temporary){if(dirname(resolve(temporary))!==resolve(tmpdir()))throw Error('Unsafe cleanup path.');await rm(temporary,{recursive:true,force:true});}
}
