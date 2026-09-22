import { expect,it } from 'vitest';
import { parseSourceReport,citationIds } from './source-report.js';
it('accepts evidence gaps and recognizes only explicit citation markers',()=>{
 expect(parseSourceReport({format:'source-report-v1',text:'No relevant code found.',citations:[]})).toMatchObject({text:'No relevant code found.'});
 expect(citationIds('A [cite:first] then [cite:first]. https://example.invalid')).toEqual(['first']);
});
it.each(['','   ','Missing [cite:unknown]'])('rejects missing evidence text or unknown markers %s',text=>{
 expect(()=>parseSourceReport({format:'source-report-v1',text,citations:[]})).toThrow();
});
