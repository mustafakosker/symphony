import type { Citation,SnapshotRef,SourcePreview,SourceReport } from '../../shared/projects.js';
import { parseSourceReport } from '../../shared/source-report.js';
import { BoundaryError } from '../../shared/validate.js';
import type { SnapshotService } from './snapshots.js';
const MAX_PREVIEW=256*1024;
async function preview(citation:Citation,allowed:SnapshotRef[],snapshots:SnapshotService):Promise<SourcePreview>{
 const source=allowed.find(s=>s.repositoryId===citation.repositoryId&&s.commit===citation.commit);
 if(!source)throw new BoundaryError('invalid','Citation references an unselected repository or commit');
 const file=await snapshots.readText(source,citation.path);
 if(file.entry.objectId!==citation.objectId||file.entry.contentDigest!==citation.contentDigest)throw new BoundaryError('conflict','Citation file identity does not match snapshot');
 const lines=file.text.split(/\r?\n/);if(lines.at(-1)==='')lines.pop();
 if(citation.endLine>lines.length)throw new BoundaryError('invalid','Citation line range does not exist');
 const range=lines.slice(citation.startLine-1,citation.endLine);
 if(Buffer.byteLength(range.join('\n'))>MAX_PREVIEW)throw new BoundaryError('invalid','Cited source range exceeds preview byte limit');
 let start=Math.max(0,citation.startLine-6),end=Math.min(lines.length,citation.endLine+5);
 const make=():SourcePreview=>({repositoryId:citation.repositoryId,commit:citation.commit,path:citation.path,firstLine:start+1,
  startLine:citation.startLine,endLine:citation.endLine,lines:lines.slice(start,end)});
 while(Buffer.byteLength(JSON.stringify(make()))>MAX_PREVIEW){
  if(start<citation.startLine-1)start++;
  else if(end>citation.endLine)end--;
  else throw new BoundaryError('invalid','Cited source range exceeds response byte limit');
 }
 return make();
}
export async function validateSourceReport(report:SourceReport,allowed:SnapshotRef[],snapshots:SnapshotService,limits:{textBytes:number;citations:number}):Promise<void>{
 const parsed=parseSourceReport(report);
 if(Buffer.byteLength(parsed.text)>limits.textBytes||parsed.citations.length>limits.citations)throw new BoundaryError('invalid','Report limits exceeded');
 for(const citation of parsed.citations)await preview(citation,allowed,snapshots);
}
export async function readCitation(report:SourceReport,citationId:string,allowed:SnapshotRef[],snapshots:SnapshotService):Promise<SourcePreview>{
 const parsed=parseSourceReport(report),citation=parsed.citations.find(c=>c.id===citationId);
 if(!citation)throw new BoundaryError('missing','Citation is not part of this report');
 return preview(citation,allowed,snapshots);
}
